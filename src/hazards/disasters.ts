import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS, miles, nearestSite } from "./common";

// How far each kind of event reaches, in miles.
const REACH: Record<string, { miles: number; label: string }> = {
  TC: { miles: 300, label: "Tropical cyclone" },
  FL: { miles: 60, label: "Flood" },
  VO: { miles: 60, label: "Volcano" },
  WF: { miles: 30, label: "Wildfire" },
};

interface GdacsFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: {
    eventtype?: string;
    eventid?: number;
    name?: string;
    htmldescription?: string;
    alertlevel?: string;
    episodealertlevel?: string;
    iscurrent?: string;
    country?: string;
    fromdate?: string;
    todate?: string;
    Class?: string;
    url?: { report?: string };
    severitydata?: { severitytext?: string };
  };
}

export function disasterSeverity(level: string, distance: number, reach: number): Severity {
  const close = distance <= reach / 3;
  if (level === "Red") return close ? "critical" : "high";
  return close ? "high" : "medium";
}

export async function parseDisasters(body: string, sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  for (const feature of (JSON.parse(body).features ?? []) as GdacsFeature[]) {
    const props = feature.properties ?? {};
    const reach = REACH[props.eventtype ?? ""];
    const level = props.episodealertlevel ?? props.alertlevel ?? "";
    // Each event comes as a centre point plus outline shapes; the point is enough.
    if (!reach || feature.geometry?.type !== "Point" || props.iscurrent === "false") continue;
    if (level !== "Orange" && level !== "Red") continue;
    const [lon, lat] = feature.geometry.coordinates ?? [];
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const near = nearestSite(sites, lat, lon, reach.miles);
    if (!near) continue;
    const name = props.name ?? `${reach.label} in ${props.country || "an unnamed area"}`;
    const until = Date.parse(`${props.todate ?? ""}Z`);
    const expiry = Math.max(Number.isNaN(until) ? 0 : until + 24 * HOUR_MS, now.getTime() + 12 * HOUR_MS);
    items.push(
      await hazardItem({
        key: `gdacs:${props.eventtype}:${props.eventid}:${level}`,
        source: "gdacs",
        category: "hazard",
        severity: disasterSeverity(level, near.miles, reach.miles),
        title: `${level} alert: ${name}`,
        summary: `GDACS rates the ${name}${props.country ? ` (${props.country})` : ""} at ${level} alert level${props.severitydata?.severitytext ? `: ${props.severitydata.severitytext}` : ""}. Its centre is ${miles(near.miles)} from ${near.site.name}.`,
        incident: name,
        url: props.url?.report ?? "https://www.gdacs.org/",
        author: "GDACS",
        publishedAt: props.fromdate ? `${props.fromdate}Z` : null,
        place: props.country ?? "",
        lat,
        lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(expiry).toISOString(),
        ongoing: true,
      }),
    );
  }
  return items;
}

export async function disasterHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  const from = new Date(now.getTime() - 10 * 24 * HOUR_MS).toISOString().slice(0, 10);
  const body = await getText(
    `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;FL;VO;WF&alertlevel=Orange;Red&fromdate=${from}`,
  );
  return parseDisasters(body, sites, now);
}
