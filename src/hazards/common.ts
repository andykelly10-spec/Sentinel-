import { distanceMiles } from "../geo";
import { sha256Hex } from "../text";
import type { Category, HazardItem, Severity, Site, SourceName } from "../types";

export const HOUR_MS = 3_600_000;

export interface NearSite {
  site: Site;
  miles: number;
}

export function nearestSite(sites: Site[], lat: number, lon: number, maxMiles: number): NearSite | null {
  let best: NearSite | null = null;
  for (const site of sites) {
    const miles = distanceMiles(lat, lon, site.lat, site.lon);
    if (miles <= maxMiles && (!best || miles < best.miles)) best = { site, miles };
  }
  return best;
}

export function bump(severity: Severity): Severity {
  return severity === "low" ? "medium" : severity === "medium" ? "high" : "critical";
}

export function utcLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface HazardFields {
  // Identifies the alert: the same key is never stored twice.
  key: string;
  source: SourceName;
  category: Category;
  severity: Severity;
  title: string;
  summary: string;
  incident: string;
  url: string;
  author: string;
  publishedAt: string | null;
  snippet?: string;
  place?: string;
  lat?: number | null;
  lon?: number | null;
  site?: string;
  distanceMi?: number | null;
  expiresAt: string | null;
  ongoing: boolean;
}

export async function hazardItem(fields: HazardFields): Promise<HazardItem> {
  return {
    id: (await sha256Hex(fields.key)).slice(0, 32),
    source: fields.source,
    url: fields.url,
    title: fields.title,
    snippet: fields.snippet ?? "",
    author: fields.author,
    publishedAt: fields.publishedAt,
    category: fields.category,
    severity: fields.severity,
    summary: fields.summary,
    incident: fields.incident,
    place: fields.place ?? "",
    lat: fields.lat ?? null,
    lon: fields.lon ?? null,
    site: fields.site ?? "",
    distanceMi: fields.distanceMi === undefined || fields.distanceMi === null ? null : Math.round(fields.distanceMi * 10) / 10,
    expiresAt: fields.expiresAt,
    ongoing: fields.ongoing,
  };
}

export function miles(value: number): string {
  return `${value < 0.1 ? "0.1" : value.toFixed(1)} miles`;
}
