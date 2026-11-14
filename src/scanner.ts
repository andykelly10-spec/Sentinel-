// Police and fire radio ("scanner") links for a place. No scanner service
// offers open data: Broadcastify's terms forbid re-streaming and OpenMHz
// blocks automated requests, so Sentinel links to their own players. The
// link goes to Broadcastify's page for the place's county when that can be
// worked out, otherwise to its page for the state.

import { getSetting, setSetting } from "./db";
import { getText } from "./sources/http";

// Broadcastify numbers US states by their FIPS codes.
export const STATE_FIPS: Record<string, number> = {
  AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, DC: 11, FL: 12, GA: 13, HI: 15, ID: 16, IL: 17, IN: 18,
  IA: 19, KS: 20, KY: 21, LA: 22, ME: 23, MD: 24, MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31, NV: 32,
  NH: 33, NJ: 34, NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40, OR: 41, PA: 42, RI: 44, SC: 45, SD: 46, TN: 47,
  TX: 48, UT: 49, VT: 50, VA: 51, WA: 53, WV: 54, WI: 55, WY: 56,
};

const BROADCASTIFY = "https://www.broadcastify.com";
const MONTH_MS = 30 * 86_400_000;

export interface ScannerLinks {
  available: boolean;
  place: string;
  broadcastify: { url: string; label: string } | null;
  openmhz: { url: string; label: string } | null;
  note: string;
}

export interface County {
  state: string;
  county: string;
}

// From an OpenStreetMap reverse lookup: the state's code and the county name.
export function parseCounty(body: string): County | null {
  const address = (JSON.parse(body) as { address?: Record<string, string> }).address ?? {};
  if ((address.country_code ?? "").toLowerCase() !== "us") return null;
  const state = (address["ISO3166-2-lvl4"] ?? "").replace(/^US-/, "");
  // Washington DC has no county; Broadcastify lists it as "District of Columbia".
  const county = state === "DC" ? "District of Columbia" : (address.county ?? address.city ?? "");
  return state in STATE_FIPS ? { state, county } : null;
}

const simplify = (name: string) =>
  name
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\b(county|parish|borough|city and borough|municipality|census area)\b/g, "")
    .replace(/[^a-z]/g, "");

// County links on a Broadcastify state page, in its county grid
// (<a href="/listen/ctid/<id>"><span ...>Name</span>) and its feed tables.
export function countyIds(html: string): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const [, id, name] of html.matchAll(/href="\/listen\/ctid\/(\d+)"[^>]*>\s*(?:<span[^>]*>)?([^<]+)</g)) {
    ids[simplify(name!)] ??= Number(id);
  }
  return ids;
}

// Broadcastify lists New York City's five boroughs as one, and DC by its city name.
const NYC_BOROUGHS = ["New York", "Kings", "Queens", "Bronx", "Richmond"].map(simplify);
export function broadcastifyName(state: string, county: string): string {
  if (state === "DC") return "washingtondc";
  if (state === "NY" && NYC_BOROUGHS.includes(simplify(county))) return "newyorkcity";
  return simplify(county);
}

async function countyId(db: D1Database, state: string, county: string, now: Date): Promise<number | null> {
  const key = `broadcastify_counties:${state}`;
  const cached = JSON.parse((await getSetting(db, key)) ?? "null") as { at: string; ids: Record<string, number> } | null;
  let ids = cached && now.getTime() - Date.parse(cached.at) < MONTH_MS ? cached.ids : null;
  if (!ids) {
    try {
      ids = countyIds(await getText(`${BROADCASTIFY}/listen/stid/${STATE_FIPS[state]}`));
    } catch {
      ids = {};
    }
    // An empty list (Broadcastify refused) is remembered for a day, not a month.
    await setSetting(db, key, JSON.stringify({ at: Object.keys(ids).length ? now.toISOString() : new Date(now.getTime() - MONTH_MS + 86_400_000).toISOString(), ids }));
  }
  return ids[broadcastifyName(state, county)] ?? null;
}

async function lookUpCounty(db: D1Database, lat: number, lon: number, now: Date): Promise<County | null> {
  const key = `county:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = JSON.parse((await getSetting(db, key)) ?? "null") as { at: string; county: County | null } | null;
  if (cached && now.getTime() - Date.parse(cached.at) < MONTH_MS) return cached.county;
  const county = parseCounty(
    await getText(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`),
  );
  await setSetting(db, key, JSON.stringify({ at: now.toISOString(), county }));
  return county;
}

export async function scannerLinks(db: D1Database, lat: number, lon: number, now: Date = new Date()): Promise<ScannerLinks> {
  const county = await lookUpCounty(db, lat, lon, now).catch(() => null);
  const openmhz = { url: "https://openmhz.com/systems", label: "Recorded radio calls by system (OpenMHz)" };
  if (!county) {
    return {
      available: false,
      place: "",
      broadcastify: null,
      openmhz: null,
      note: "Police radio links are available for US locations. Elsewhere, police radio is usually encrypted.",
    };
  }
  const id = await countyId(db, county.state, county.county, now);
  const place = county.state === "DC" ? "Washington, DC" : `${county.county}, ${county.state}`;
  return {
    available: true,
    place,
    broadcastify: id
      ? { url: `${BROADCASTIFY}/listen/ctid/${id}`, label: `Live police, fire and EMS radio for ${place} (Broadcastify)` }
      : { url: `${BROADCASTIFY}/listen/stid/${STATE_FIPS[county.state]}`, label: `Live police, fire and EMS radio in ${county.state}: choose ${county.county} (Broadcastify)` },
    openmhz,
    note: "Many big-city police departments now encrypt their main channels; fire, EMS and suburban agencies are usually still open.",
  };
}
