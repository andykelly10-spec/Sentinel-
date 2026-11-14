// Live 911 dispatch logs that cities publish as open data. Each call has a
// type and exact coordinates, so serious calls close to a site, or to you,
// become alerts within minutes. Only cities with a near-real-time feed are listed.

import { truncate } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS, miles, nearestSite } from "./common";
import { distanceMiles } from "../geo";

// Calls older than this are left out; dispatch alerts expire after it too.
const MAX_AGE_MS = 3 * HOUR_MS;
// How close a call must be to a company site; your own radius is used for you.
export const SITE_RADIUS_MILES = 1;
// Lesser calls (a robbery, a car fire) only count this close.
const MEDIUM_RADIUS_MILES = 0.5;

export interface DispatchCall {
  key: string;
  type: string;
  address: string;
  lat: number;
  lon: number;
  time: string;
}

export interface DispatchFeed {
  id: string;
  agency: string;
  city: string;
  center: [number, number];
  // Sites farther than this from the centre are outside the feed's area.
  coverMiles: number;
  url: string;
  page: string;
  parse: (body: string) => DispatchCall[];
  severity: (type: string) => Severity | null;
}

// Converts a wall-clock time in a time zone ("2026-11-13T16:26:00.000") to UTC.
export function zonedToIso(local: string, timeZone: string): string | null {
  const asUtc = Date.parse(`${local.replace(/Z$/, "")}Z`);
  if (Number.isNaN(asUtc)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(asUtc));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

export function seattleSeverity(type: string): Severity | null {
  if (/scenes? of violence|fire in (building|high rise)|working fire|commercial fire|residential fire|^hazmat(?! reduced)|natural gas leak major|multiple alarm|mass casualty|\bmci\b|explosion|^[45]red/i.test(type)) return "high";
  if (/hazmat reduced|natural gas leak|brush fire|w\/exp|tran?sformer fire|wires down|rescue extrication|water rescue response|^3red|bomb/i.test(type)) return "medium";
  return null;
}

export function sfPoliceSeverity(type: string): Severity | null {
  // Domestic calls happen inside homes and are no danger to passers-by.
  if (/\bDV\b/.test(type)) return null;
  if (/ACTIVE SHOOTER|EXPLOSION/.test(type)) return "critical";
  if (/SHOOTING|SHOTS FIRED|SHOT SPOTTER|PERSON W\/GUN|STABBING|BOMB THREAT|SUSPICIOUS MAILING|KIDNAPPING|AGG ASSAULT|FIGHT W\/WEAPONS|ARMED/.test(type)) return "high";
  if (/PERSON W\/KNIFE|ROBBERY|HOLDUP|PERSON BREAKING IN|^FIRE$/.test(type)) return "medium";
  return null;
}

const number = (value: unknown) => (typeof value === "string" || typeof value === "number" ? Number(value) : NaN);

export const FEEDS: DispatchFeed[] = [
  {
    id: "seattle",
    agency: "Seattle Fire Department",
    city: "Seattle",
    center: [47.6062, -122.3321],
    coverMiles: 15,
    url: "https://data.seattle.gov/resource/kzjm-xkqj.json?$order=datetime%20DESC&$limit=150",
    page: "https://data.seattle.gov/d/kzjm-xkqj",
    severity: seattleSeverity,
    parse: (body) =>
      (JSON.parse(body) as Array<Record<string, unknown>>).flatMap((row) => {
        const time = typeof row.datetime === "string" ? zonedToIso(row.datetime, "America/Los_Angeles") : null;
        const lat = number(row.latitude);
        const lon = number(row.longitude);
        if (!time || !Number.isFinite(lat) || !Number.isFinite(lon) || typeof row.incident_number !== "string") return [];
        return [{ key: `seattle:${row.incident_number}`, type: String(row.type ?? ""), address: String(row.address ?? ""), lat, lon, time }];
      }),
  },
  {
    id: "sf_police",
    agency: "San Francisco Police Department",
    city: "San Francisco",
    center: [37.7749, -122.4194],
    coverMiles: 10,
    url: "https://data.sfgov.org/resource/gnap-fj3t.json?$order=received_datetime%20DESC&$limit=400",
    page: "https://data.sfgov.org/d/gnap-fj3t",
    severity: sfPoliceSeverity,
    parse: (body) =>
      (JSON.parse(body) as Array<Record<string, unknown>>).flatMap((row) => {
        const point = row.intersection_point as { coordinates?: [number, number] } | undefined;
        const time = typeof row.received_datetime === "string" ? zonedToIso(row.received_datetime, "America/Los_Angeles") : null;
        if (row.sensitive_call === true || !point?.coordinates || !time || typeof row.cad_number !== "string") return [];
        const type = String(row.call_type_final_desc ?? row.call_type_original_desc ?? "");
        const address = String(row.intersection_name ?? "").replace(/\s*\\\s*/g, " & ");
        return [{ key: `sf:${row.cad_number}`, type, address, lat: point.coordinates[1], lon: point.coordinates[0], time }];
      }),
  },
];

const titleCase = (text: string) => text.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }) + " Pacific";
}

export async function callsToItems(feed: DispatchFeed, calls: DispatchCall[], sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.key)) continue;
    seen.add(call.key);
    const age = now.getTime() - Date.parse(call.time);
    if (age > MAX_AGE_MS || age < -HOUR_MS) continue;
    const severity = feed.severity(call.type);
    if (!severity) continue;
    // Each site has its own radius (yours is the one you chose); lesser calls must be closer.
    const inRange = sites.filter((site) => {
      const radius = site.radiusMi ?? SITE_RADIUS_MILES;
      const limit = severity === "medium" ? Math.min(radius, MEDIUM_RADIUS_MILES) : radius;
      return distanceMiles(call.lat, call.lon, site.lat, site.lon) <= limit;
    });
    const near = nearestSite(inRange, call.lat, call.lon, Infinity);
    if (!near) continue;
    const type = titleCase(call.type);
    const where = titleCase(call.address);
    items.push(
      await hazardItem({
        key: `dispatch:${call.key}`,
        source: "dispatch",
        category: "physical",
        severity,
        title: `${type} at ${where}`,
        summary: truncate(`${feed.agency} was dispatched to a ${type.toLowerCase()} call at ${where}, ${miles(near.miles)} from ${near.site.name}, at ${localTime(call.time)}.`, 400),
        incident: `${type}, ${where}`,
        url: feed.page,
        author: `${feed.agency} 911 dispatch`,
        publishedAt: call.time,
        place: `${where}, ${feed.city}`,
        lat: call.lat,
        lon: call.lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(Date.parse(call.time) + MAX_AGE_MS).toISOString(),
        ongoing: false,
      }),
    );
  }
  return items;
}

// Reads only the feeds whose city has a site (or you) in it.
export async function dispatchHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  const feeds = FEEDS.filter((feed) => sites.some((site) => distanceMiles(site.lat, site.lon, ...feed.center) <= feed.coverMiles));
  const results = await Promise.all(feeds.map(async (feed) => callsToItems(feed, feed.parse(await getText(feed.url)), sites, now)));
  return results.flat();
}
