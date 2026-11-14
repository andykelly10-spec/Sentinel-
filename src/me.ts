// "Your location": the dashboard user's own position, watched like a company
// site while they ask for alerts near them. The browser sends its position
// (rounded to about 100 m) and the checks treat it as one more site until it
// goes quiet for MY_LOCATION_TTL_MS.

import { getSetting, setSetting } from "./db";
import { distanceMiles } from "./geo";
import { parseNwsPoint } from "./hazards/weather";
import { getText } from "./sources/http";
import type { Site } from "./types";

export const MY_SITE_NAME = "Your location";
export const MY_SITE_ID = -1;
const SETTING = "my_location";

// Watching stops this long after the last update from a browser.
export const MY_LOCATION_TTL_MS = 12 * 3_600_000;
export const RADIUS_CHOICES = [0.5, 1, 2, 5, 10];
const DEFAULT_RADIUS = 1;
// The place name, ZIP code and weather zones are looked up again after a move this far.
const RELOCATE_MILES = 1;

export interface MyLocation {
  lat: number;
  lon: number;
  accuracyM: number | null;
  radiusMi: number;
  updatedAt: string;
  // Where the place details below were looked up.
  placeLat: number;
  placeLon: number;
  label: string;
  neighbourhood: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
  nwsZones: string;
}

export interface Place {
  label: string;
  neighbourhood: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export async function getMyLocation(db: D1Database): Promise<MyLocation | null> {
  const raw = await getSetting(db, SETTING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MyLocation;
  } catch {
    return null;
  }
}

// The stored location, if a browser has updated it recently enough to watch.
export async function activeLocation(db: D1Database, now: Date): Promise<MyLocation | null> {
  const me = await getMyLocation(db);
  return me && now.getTime() - Date.parse(me.updatedAt) <= MY_LOCATION_TTL_MS ? me : null;
}

export async function clearMyLocation(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(SETTING).run();
}

export function parseNominatim(body: string): Place {
  const data = JSON.parse(body) as { address?: Record<string, string> };
  const address = data.address ?? {};
  const neighbourhood = address.neighbourhood ?? address.quarter ?? address.suburb ?? "";
  const city = address.city ?? address.town ?? address.village ?? address.municipality ?? address.hamlet ?? address.county ?? "";
  const region = address.state ?? address.region ?? "";
  const label = [...new Set([neighbourhood, city, region].filter(Boolean))].join(", ");
  return {
    label,
    neighbourhood: neighbourhood === city ? "" : neighbourhood,
    city,
    region,
    postcode: (address.postcode ?? "").split(/[;,]/)[0]!.trim(),
    country: (address.country_code ?? "").toUpperCase(),
  };
}

// OpenStreetMap's Nominatim service turns coordinates into a place name and
// postcode. Its usage policy allows occasional lookups like these (one per move).
async function lookUpPlace(lat: number, lon: number): Promise<Place> {
  return parseNominatim(
    await getText(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`),
  );
}

async function lookUpZones(lat: number, lon: number): Promise<string> {
  try {
    return parseNwsPoint(await getText(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).zones.join(",");
  } catch {
    return "";
  }
}

export interface LocationUpdate {
  lat: number;
  lon: number;
  radiusMi?: number;
  accuracyM?: number | null;
}

export function validUpdate(body: unknown): LocationUpdate | null {
  const value = body as Partial<LocationUpdate> | null;
  const { lat, lon } = value ?? {};
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    radiusMi: RADIUS_CHOICES.includes(value?.radiusMi as number) ? value!.radiusMi : DEFAULT_RADIUS,
    accuracyM: typeof value?.accuracyM === "number" && Number.isFinite(value.accuracyM) ? Math.round(value.accuracyM) : null,
  };
}

// Saves a new position. `moved` is true when the place was looked up afresh,
// which is when an immediate check near the new position is worthwhile.
export async function updateMyLocation(
  db: D1Database,
  update: LocationUpdate,
  now: Date,
): Promise<{ location: MyLocation; moved: boolean }> {
  const lat = round(update.lat);
  const lon = round(update.lon);
  const previous = await getMyLocation(db);
  const moved = !previous || distanceMiles(previous.placeLat, previous.placeLon, lat, lon) > RELOCATE_MILES;

  let place: Place & { nwsZones: string; placeLat: number; placeLon: number };
  if (moved) {
    const found = await lookUpPlace(lat, lon).catch(
      (): Place => ({ label: "", neighbourhood: "", city: "", region: "", postcode: "", country: previous?.country ?? "" }),
    );
    place = { ...found, nwsZones: found.country === "US" ? await lookUpZones(lat, lon) : "", placeLat: lat, placeLon: lon };
  } else {
    place = previous;
  }

  const location: MyLocation = {
    lat,
    lon,
    accuracyM: update.accuracyM ?? null,
    radiusMi: update.radiusMi ?? previous?.radiusMi ?? DEFAULT_RADIUS,
    updatedAt: now.toISOString(),
    placeLat: place.placeLat,
    placeLon: place.placeLon,
    label: place.label,
    neighbourhood: place.neighbourhood,
    city: place.city,
    region: place.region,
    postcode: place.postcode,
    country: place.country,
    nwsZones: place.nwsZones,
  };
  await setSetting(db, SETTING, JSON.stringify(location));
  return { location, moved };
}

// Your location as a site, so every check that measures distance to sites covers it.
export function mySite(me: MyLocation): Site {
  return {
    id: MY_SITE_ID,
    name: MY_SITE_NAME,
    address: me.label,
    city: me.city,
    country: me.country,
    lat: me.lat,
    lon: me.lon,
    area: me.city,
    keywords: me.neighbourhood,
    priority: true,
    approximate: false,
    nws_zones: me.nwsZones,
    region: me.region,
    radiusMi: me.radiusMi,
  };
}

export function withMyLocation(sites: Site[], me: MyLocation | null): Site[] {
  return me ? [...sites, mySite(me)] : sites;
}
