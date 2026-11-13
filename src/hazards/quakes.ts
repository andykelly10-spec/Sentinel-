import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { bump, hazardItem, HOUR_MS, miles, nearestSite } from "./common";

// Bigger earthquakes matter further away.
export function quakeSeverity(magnitude: number, distance: number, tsunami: boolean): Severity | null {
  let severity: Severity | null = null;
  if (magnitude >= 7) severity = distance <= 150 ? "critical" : distance <= 300 ? "high" : null;
  else if (magnitude >= 6) severity = distance <= 60 ? "critical" : distance <= 200 ? "high" : null;
  else if (magnitude >= 5) severity = distance <= 30 ? "high" : distance <= 100 ? "medium" : null;
  else if (magnitude >= 4) severity = distance <= 15 ? "medium" : distance <= 40 ? "low" : null;
  else if (magnitude >= 2.5) severity = distance <= 10 ? "low" : null;
  return severity && tsunami ? bump(severity) : severity;
}

interface UsgsFeature {
  id?: string;
  geometry?: { coordinates?: number[] };
  properties?: { mag?: number | null; place?: string | null; time?: number; url?: string; title?: string; tsunami?: number };
}

export async function parseQuakes(body: string, sites: Site[]): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  for (const feature of (JSON.parse(body).features ?? []) as UsgsFeature[]) {
    const [lon, lat, depth] = feature.geometry?.coordinates ?? [];
    const { mag, place, time, url, title, tsunami } = feature.properties ?? {};
    if (typeof lat !== "number" || typeof lon !== "number" || typeof mag !== "number" || typeof time !== "number") continue;
    const near = nearestSite(sites, lat, lon, 300);
    const severity = near && quakeSeverity(mag, near.miles, tsunami === 1);
    if (!near || !severity) continue;
    items.push(
      await hazardItem({
        key: `usgs:${feature.id}`,
        source: "usgs",
        category: "hazard",
        severity,
        title: title ?? `M ${mag.toFixed(1)} earthquake`,
        summary:
          `A magnitude ${mag.toFixed(1)} earthquake struck ${place ?? "an unnamed location"}` +
          `${typeof depth === "number" ? ` at a depth of ${Math.round(depth)} km` : ""}, ${miles(near.miles)} from ${near.site.name}.` +
          (tsunami === 1 ? " USGS has flagged it for possible tsunami impact." : ""),
        incident: `M${mag.toFixed(1)} earthquake, ${place ?? "unknown location"}`,
        url: url ?? "https://earthquake.usgs.gov/earthquakes/map/",
        author: "USGS",
        publishedAt: new Date(time).toISOString(),
        place: place ?? "",
        lat,
        lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(time + 72 * HOUR_MS).toISOString(),
        ongoing: false,
      }),
    );
  }
  return items;
}

export async function quakeHazards(sites: Site[]): Promise<HazardItem[]> {
  return parseQuakes(await getText("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"), sites);
}
