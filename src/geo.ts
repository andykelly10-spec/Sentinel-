import { normalizeTitle } from "./text";
import type { Site } from "./types";

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
  sites: Array<Pick<Site, "name" | "lat" | "lon">>,
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

// Place words that tie a report to a site: each site's city plus its extra
// keywords, normalised so punctuation does not matter ("D.C." matches "d c").
export function placeWords(sites: Array<Pick<Site, "city" | "keywords">>): string[] {
  const words = sites.flatMap((site) => [site.city, ...site.keywords.split(",")]);
  return [...new Set(words.map(normalizeTitle).filter((word) => word.length >= 2))];
}

export function mentionsPlace(text: string, words: string[]): boolean {
  const normalized = ` ${normalizeTitle(text)} `;
  return words.some((word) => normalized.includes(` ${word} `));
}

// Distinct search areas of priority sites, most sites first.
export function priorityAreas(sites: Array<Pick<Site, "area" | "city" | "priority">>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const area = (site.area || site.city).trim();
    if (site.priority && area) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([area]) => area);
}
