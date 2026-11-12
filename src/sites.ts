import { estimateCoordinates, type Address } from "./classify";
import { parseCsv } from "./csv";
import type Anthropic from "@anthropic-ai/sdk";
import type { NewSite } from "./types";

export const MAX_SITES = 1000;
const GEOCODE_BATCH = 50;

const COLUMN_ALIASES: Record<string, string> = {
  name: "name",
  site: "name",
  "site name": "name",
  building: "name",
  address: "address",
  street: "address",
  city: "city",
  town: "city",
  country: "country",
  lat: "lat",
  latitude: "lat",
  lon: "lon",
  lng: "lon",
  long: "lon",
  longitude: "lon",
  area: "area",
  keywords: "keywords",
  priority: "priority",
};

export interface ParsedSites {
  sites: Array<Omit<NewSite, "lat" | "lon"> & { lat: number | null; lon: number | null }>;
  skipped: string[];
}

function numberOrNull(value: string, limit: number): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

// Reads a site list exported from a spreadsheet. The first row names the
// columns; only a name plus either coordinates or a city is required.
export function parseSitesCsv(text: string): ParsedSites {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("The file is empty.");
  const columns = header.map((cell) => COLUMN_ALIASES[cell.trim().toLowerCase()] ?? "");
  if (!columns.includes("name")) {
    throw new Error('The first row must name the columns, including one called "name".');
  }
  if (rows.length > MAX_SITES) throw new Error(`A site list can hold at most ${MAX_SITES} rows.`);

  const sites: ParsedSites["sites"] = [];
  const skipped: string[] = [];
  for (const [index, cells] of rows.entries()) {
    const value = (column: string) => (cells[columns.indexOf(column)] ?? "").trim();
    const name = value("name");
    const lat = numberOrNull(value("lat"), 90);
    const lon = numberOrNull(value("lon"), 180);
    const located = lat !== null && lon !== null;
    if (!name) {
      skipped.push(`Row ${index + 2}: no name`);
    } else if (!located && !value("city") && !value("address")) {
      skipped.push(`Row ${index + 2} (${name}): needs coordinates, a city or an address`);
    } else {
      sites.push({
        name,
        address: value("address"),
        city: value("city"),
        country: value("country"),
        lat: located ? lat : null,
        lon: located ? lon : null,
        area: value("area"),
        keywords: value("keywords"),
        priority: /^(1|y|yes|true|x)$/i.test(value("priority")),
        approximate: !located,
      });
    }
  }
  return { sites, skipped };
}

// Fills in coordinates for sites that came without them.
export async function locateSites(
  client: Anthropic,
  model: string,
  parsed: ParsedSites,
): Promise<{ sites: NewSite[]; skipped: string[] }> {
  const skipped = [...parsed.skipped];
  const missing = parsed.sites.filter((site) => site.lat === null);
  for (let i = 0; i < missing.length; i += GEOCODE_BATCH) {
    const batch = missing.slice(i, i + GEOCODE_BATCH);
    const addresses: Address[] = batch.map(({ name, address, city, country }) => ({ name, address, city, country }));
    const estimates = await estimateCoordinates(client, model, addresses);
    for (const [index, site] of batch.entries()) {
      const estimate = estimates[index];
      if (estimate) {
        site.lat = estimate.lat;
        site.lon = estimate.lon;
      } else {
        skipped.push(`${site.name}: could not work out where this is`);
      }
    }
  }
  const sites = parsed.sites.filter((site): site is NewSite => site.lat !== null && site.lon !== null);
  return { sites, skipped };
}
