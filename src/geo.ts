import type { Site } from "./watchlist";

const EARTH_RADIUS_MILES = 3958.8;
// Beyond this an event is not "near" a site in any useful sense.
const MAX_NEARBY_MILES = 25;

export function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

export function nearestSite(
  lat: number | null,
  lon: number | null,
  sites: Site[],
): { site: string; distanceMi: number } | null {
  if (lat === null || lon === null) return null;
  let best: { site: string; distanceMi: number } | null = null;
  for (const site of sites) {
    const miles = distanceMiles(lat, lon, site.lat, site.lon);
    if (miles <= MAX_NEARBY_MILES && (!best || miles < best.distanceMi)) {
      best = { site: site.name, distanceMi: Math.round(miles * 10) / 10 };
    }
  }
  return best;
}

export function proximityLabel(site: string, distanceMi: number | null): string {
  if (!site || distanceMi === null) return "";
  return `about ${distanceMi < 0.1 ? "0.1" : distanceMi} mi from ${site}`;
}
