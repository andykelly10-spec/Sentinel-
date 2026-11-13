import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS, miles, nearestSite } from "./common";

const MEANING: Record<string, string> = { "7500": "hijack", "7700": "general emergency" };

export function squawkSeverity(squawk: string, distance: number, altitude: number | "ground" | undefined): Severity | null {
  if (distance > 25) return null;
  if (squawk === "7500") return "critical";
  const low = altitude === "ground" || (typeof altitude === "number" && altitude < 10_000);
  return distance <= 10 && low ? "medium" : "low";
}

interface Aircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  squawk?: string;
}

export async function parseSquawks(body: string, squawk: string, sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  for (const craft of (JSON.parse(body).ac ?? []) as Aircraft[]) {
    if (typeof craft.lat !== "number" || typeof craft.lon !== "number" || !craft.hex) continue;
    const near = nearestSite(sites, craft.lat, craft.lon, 25);
    const severity = near && squawkSeverity(squawk, near.miles, craft.alt_baro);
    if (!near || !severity) continue;
    const callsign = (craft.flight ?? craft.r ?? craft.hex).trim();
    const altitude = craft.alt_baro === "ground" ? "on the ground" : typeof craft.alt_baro === "number" ? `at ${craft.alt_baro.toLocaleString("en-US")} ft` : "altitude unknown";
    items.push(
      await hazardItem({
        key: `sqk:${craft.hex}:${squawk}:${now.toISOString().slice(0, 10)}`,
        source: "aircraft",
        category: "physical",
        severity,
        title: `${callsign} squawking ${squawk} (${MEANING[squawk]})`,
        summary: `Aircraft ${callsign}${craft.t ? ` (${craft.t})` : ""} is transmitting code ${squawk}, which signals a ${MEANING[squawk]}, ${altitude}, ${miles(near.miles)} from ${near.site.name}.`,
        incident: `${callsign} squawking ${squawk}`,
        url: `https://globe.adsb.lol/?icao=${encodeURIComponent(craft.hex)}`,
        author: "ADS-B Exchange community feed (adsb.lol)",
        publishedAt: now.toISOString(),
        lat: craft.lat,
        lon: craft.lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(now.getTime() + 2 * HOUR_MS).toISOString(),
        ongoing: true,
      }),
    );
  }
  return items;
}

export async function aircraftHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  const codes = Object.keys(MEANING);
  const pages = await Promise.all(codes.map((code) => getText(`https://api.adsb.lol/v2/sqk/${code}`)));
  return (await Promise.all(pages.map((page, index) => parseSquawks(page, codes[index]!, sites, now)))).flat();
}
