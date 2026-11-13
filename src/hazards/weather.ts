import { truncate } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, utcLabel } from "./common";

const ZONES_PER_REQUEST = 40;

const SEVERITY: Record<string, Severity> = { Extreme: "critical", Severe: "high", Moderate: "medium" };

// Messages about danger to people rather than weather, urgent whatever their stated severity.
const CIVIL_EVENTS = [
  "Evacuation", "Civil Danger", "Civil Emergency", "Shelter In Place", "Law Enforcement", "Hazardous Materials",
  "Nuclear Power Plant", "Radiological Hazard", "911 Telephone Outage", "Local Area Emergency",
];

// Events that bear on the safety of staff or the running of a site. Others
// (frost, surf, small craft and the like) are left out.
const SAFETY_EVENTS = [
  "Tornado", "Severe Thunderstorm", "Flash Flood", "Flood", "Hurricane", "Typhoon", "Tropical Storm", "Storm Surge",
  "Tsunami", "Extreme Wind", "High Wind", "Blizzard", "Ice Storm", "Winter Storm", "Red Flag", "Fire Weather",
  "Fire Warning", "Extreme Heat", "Excessive Heat", "Extreme Cold", "Dust Storm", "Earthquake", "Avalanche",
  ...CIVIL_EVENTS,
];

export function weatherSeverity(event: string, nwsSeverity: string): Severity | null {
  if (!SAFETY_EVENTS.some((name) => event.includes(name))) return null;
  const civil = CIVIL_EVENTS.some((name) => event.includes(name));
  const base = SEVERITY[nwsSeverity] ?? (civil ? "high" : null);
  if (!base) return null;
  if (civil) return base === "critical" ? "critical" : "high";
  if (/Warning|Emergency|Immediate/.test(event)) return base;
  // A watch means conditions are possible, not happening.
  if (/Watch/.test(event)) return "medium";
  // Advisories and statements are left out.
  return null;
}

export interface ZoneLookup {
  id: number;
  nwsZones: string;
  region: string;
}

const lastSegment = (url: unknown) => (typeof url === "string" ? (url.split("/").pop() ?? "") : "");

export function parseNwsPoint(body: string): { zones: string[]; region: string } {
  const properties = JSON.parse(body).properties ?? {};
  const zones = [properties.forecastZone, properties.county, properties.fireWeatherZone].map(lastSegment).filter(Boolean);
  return { zones: [...new Set<string>(zones)], region: String(properties.relativeLocation?.properties?.state ?? "") };
}

// Finds the NWS zones for sites not looked up yet. Sites outside the US are
// marked as outside coverage without a request.
export async function resolveZones(sites: Site[], limit: number): Promise<ZoneLookup[]> {
  const pending = sites.filter((site) => site.nws_zones === null);
  const results: ZoneLookup[] = pending
    .filter((site) => site.country !== "US")
    .map((site) => ({ id: site.id, nwsZones: "", region: "" }));
  const lookups = await Promise.allSettled(
    pending
      .filter((site) => site.country === "US")
      .slice(0, limit)
      .map(async (site) => {
        try {
          const point = parseNwsPoint(await getText(`https://api.weather.gov/points/${site.lat.toFixed(4)},${site.lon.toFixed(4)}`));
          return { id: site.id, nwsZones: point.zones.join(","), region: point.region };
        } catch (error) {
          // Offshore or unknown points answer 404 and will never resolve.
          if (error instanceof Error && error.message === "HTTP 404") return { id: site.id, nwsZones: "", region: "" };
          throw error;
        }
      }),
  );
  for (const lookup of lookups) if (lookup.status === "fulfilled") results.push(lookup.value);
  return results;
}

interface NwsAlert {
  id?: string;
  properties?: {
    id?: string;
    event?: string;
    headline?: string | null;
    description?: string | null;
    severity?: string;
    areaDesc?: string;
    sent?: string;
    expires?: string | null;
    ends?: string | null;
    status?: string;
    messageType?: string;
    geocode?: { UGC?: string[] };
  };
}

export async function parseWeatherAlerts(body: string, sites: Site[]): Promise<HazardItem[]> {
  const zoneSites = new Map<string, Site[]>();
  for (const site of sites) {
    for (const zone of (site.nws_zones ?? "").split(",").filter(Boolean)) {
      zoneSites.set(zone, [...(zoneSites.get(zone) ?? []), site]);
    }
  }
  const items: HazardItem[] = [];
  for (const alert of (JSON.parse(body).features ?? []) as NwsAlert[]) {
    const props = alert.properties ?? {};
    const severity = weatherSeverity(props.event ?? "", props.severity ?? "");
    if (!severity || props.status !== "Actual" || props.messageType === "Cancel") continue;
    const affected = [...new Set((props.geocode?.UGC ?? []).flatMap((zone) => zoneSites.get(zone) ?? []))].sort(
      (a, b) => Number(b.priority) - Number(a.priority) || a.name.localeCompare(b.name),
    );
    const lead = affected[0];
    if (!lead) continue;
    const event = props.event ?? "Weather alert";
    const until = utcLabel(props.ends ?? props.expires);
    const names = affected.slice(0, 4).map((site) => site.name).join(", ") + (affected.length > 4 ? ` and ${affected.length - 4} more` : "");
    items.push(
      await hazardItem({
        key: `nws:${props.id ?? alert.id}`,
        source: "nws",
        category: "hazard",
        severity,
        title: props.headline || event,
        summary: `${event} in effect for ${truncate(props.areaDesc ?? "the area", 160)}${until ? ` until ${until}` : ""}. It covers ${affected.length === 1 ? "the site" : `${affected.length} company sites`}: ${names}.`,
        incident: `${event}, ${lead.city || lead.name}`,
        url: `https://forecast.weather.gov/MapClick.php?lat=${lead.lat}&lon=${lead.lon}`,
        author: "National Weather Service",
        publishedAt: props.sent ?? null,
        snippet: truncate((props.description ?? "").replace(/\s+/g, " ").trim(), 600),
        place: truncate(props.areaDesc ?? "", 120),
        lat: lead.lat,
        lon: lead.lon,
        site: lead.name,
        distanceMi: 0,
        expiresAt: props.ends ?? props.expires ?? null,
        ongoing: true,
      }),
    );
  }
  return items;
}

export async function weatherHazards(sites: Site[]): Promise<HazardItem[]> {
  const zones = [...new Set(sites.flatMap((site) => (site.nws_zones ?? "").split(",").filter(Boolean)))];
  const pages: string[] = [];
  for (let i = 0; i < zones.length; i += ZONES_PER_REQUEST) {
    pages.push(await getText(`https://api.weather.gov/alerts/active?status=actual&zone=${zones.slice(i, i + ZONES_PER_REQUEST).join(",")}`));
  }
  // An alert spanning zones in two requests appears in both; the shared key keeps one.
  return (await Promise.all(pages.map((page) => parseWeatherAlerts(page, sites)))).flat();
}
