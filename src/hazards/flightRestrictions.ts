import { normalizeTitle } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS } from "./common";

const SEVERITY: Record<string, Severity> = { VIP: "medium", SECURITY: "medium", HAZARDS: "low" };
const IGNORED = new Set(["SPACE OPERATIONS"]);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Standing restrictions (over Washington, for example) are not news.
const STANDING_AFTER_MS = 14 * 24 * HOUR_MS;

export function restrictionStart(description: string): number | null {
  const match = description.match(new RegExp(`(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})`));
  return match ? Date.UTC(Number(match[3]), MONTHS.indexOf(match[1]!), Number(match[2])) : null;
}

interface Restriction {
  notam_id?: string;
  type?: string;
  state?: string;
  description?: string;
}

// The FAA list gives a city rather than coordinates, so restrictions are tied
// to sites in the same city and state.
export async function parseRestrictions(body: string, sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  for (const entry of JSON.parse(body) as Restriction[]) {
    const type = (entry.type ?? "").toUpperCase();
    if (!entry.notam_id || !entry.description || IGNORED.has(type)) continue;
    const start = restrictionStart(entry.description);
    if (start !== null && now.getTime() - start > STANDING_AFTER_MS) continue;
    const city = normalizeTitle(entry.description.split(",")[0] ?? "");
    const matches = sites.filter((site) => site.country === "US" && site.region === entry.state && normalizeTitle(site.city) === city);
    if (!city || matches.length === 0) continue;
    const cityLabel = entry.description.split(",")[0]!.trim();
    const kind = type ? type.charAt(0) + type.slice(1).toLowerCase() : "Temporary";
    items.push(
      await hazardItem({
        key: `tfr:${entry.notam_id}`,
        source: "faa_tfr",
        category: "hazard",
        severity: SEVERITY[type] ?? "low",
        title: `${kind} flight restriction: ${entry.description}`,
        summary:
          `The FAA has issued a ${type.toLowerCase() || "temporary"} flight restriction (NOTAM ${entry.notam_id}) for ${entry.description}, where the company has ${matches.length === 1 ? matches[0]!.name : `${matches.length} sites`}.` +
          (type === "VIP" ? " VIP restrictions usually accompany high-profile visits and can bring road closures and security perimeters." : ""),
        incident: `${kind} flight restriction, ${cityLabel}`,
        url: "https://tfr.faa.gov/",
        author: "Federal Aviation Administration",
        publishedAt: now.toISOString(),
        place: `${cityLabel}, ${entry.state}`,
        site: matches[0]!.name,
        expiresAt: new Date(now.getTime() + 12 * HOUR_MS).toISOString(),
        ongoing: true,
      }),
    );
  }
  return items;
}

export async function restrictionHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  return parseRestrictions(await getText("https://tfr.faa.gov/tfrapi/exportTfrList"), sites, now);
}
