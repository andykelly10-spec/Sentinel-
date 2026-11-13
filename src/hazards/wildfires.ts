import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS, miles, nearestSite } from "./common";

export const WILDFIRE_QUERY =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query" +
  "?where=" +
  encodeURIComponent("IncidentTypeCategory='WF' AND (PercentContained IS NULL OR PercentContained < 100)") +
  "&outFields=IrwinID,IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,POOState,POOCounty" +
  "&outSR=4326&f=json";

export function fireSeverity(distance: number, acres: number): Severity | null {
  // New reports often have no size yet; they count only when very close, and
  // are announced again once they grow.
  if (acres < 1) return distance <= 2 ? "low" : null;
  if (distance <= 5) return acres >= 100 ? "critical" : acres >= 10 ? "high" : "medium";
  if (distance <= 15) return acres >= 1000 ? "high" : acres >= 100 ? "medium" : "low";
  if (distance <= 30) return acres >= 5000 ? "medium" : acres >= 500 ? "low" : null;
  return null;
}

interface FireFeature {
  attributes?: {
    IrwinID?: string;
    IncidentName?: string;
    IncidentSize?: number | null;
    PercentContained?: number | null;
    FireDiscoveryDateTime?: number | null;
    POOState?: string | null;
    POOCounty?: string | null;
  };
  geometry?: { x?: number; y?: number };
}

export async function parseWildfires(body: string, sites: Site[], now: Date): Promise<HazardItem[]> {
  const parsed = JSON.parse(body);
  if (parsed.error) throw new Error(parsed.error.message ?? "Wildfire query failed");
  const items: HazardItem[] = [];
  for (const { attributes: fire = {}, geometry } of (parsed.features ?? []) as FireFeature[]) {
    const lat = geometry?.y;
    const lon = geometry?.x;
    if (typeof lat !== "number" || typeof lon !== "number" || !fire.IrwinID) continue;
    const acres = fire.IncidentSize ?? 0;
    const near = nearestSite(sites, lat, lon, 30);
    const severity = near && fireSeverity(near.miles, acres);
    if (!near || !severity) continue;
    const name = (fire.IncidentName ?? "Unnamed").trim();
    const label = /fire$/i.test(name) ? name : `${name} Fire`;
    const state = (fire.POOState ?? "").replace(/^US-/, "");
    const contained = typeof fire.PercentContained === "number" ? `${fire.PercentContained}% contained` : "containment not reported";
    items.push(
      await hazardItem({
        // A fire that grows or moves closer reaches a new severity and is announced again.
        key: `fire:${fire.IrwinID}:${severity}`,
        source: "wildfire",
        category: "hazard",
        severity,
        title: `${label}: ${Math.round(acres).toLocaleString("en-US")} acres, ${contained}`,
        summary: `The ${label}${fire.POOCounty ? ` in ${fire.POOCounty} County${state ? `, ${state}` : ""}` : ""} has burned about ${Math.round(acres).toLocaleString("en-US")} acres and is ${contained}. It is ${miles(near.miles)} from ${near.site.name}.`,
        incident: `${label}${state ? `, ${state}` : ""}`,
        url: `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`,
        author: "National Interagency Fire Center",
        publishedAt: fire.FireDiscoveryDateTime ? new Date(fire.FireDiscoveryDateTime).toISOString() : null,
        place: [fire.POOCounty && `${fire.POOCounty} County`, state].filter(Boolean).join(", "),
        lat,
        lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(now.getTime() + 12 * HOUR_MS).toISOString(),
        ongoing: true,
      }),
    );
  }
  return items;
}

export async function wildfireHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  return parseWildfires(await getText(WILDFIRE_QUERY), sites, now);
}
