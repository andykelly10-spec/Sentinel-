import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { getSetting, listAlerts, listSites, saveSites } from "../src/db";
import { runHazards } from "../src/hazards";
import { advisoryChanges, parseAdvisories } from "../src/hazards/advisories";
import { parseSquawks, squawkSeverity } from "../src/hazards/aircraft";
import { disasterSeverity, parseDisasters } from "../src/hazards/disasters";
import { findLookalikes, lookalikeItem, registeredDomain } from "../src/hazards/domains";
import { parseRestrictions, restrictionStart } from "../src/hazards/flightRestrictions";
import { parseQuakes, quakeSeverity } from "../src/hazards/quakes";
import { parseNwsPoint, parseWeatherAlerts, weatherSeverity } from "../src/hazards/weather";
import { fireSeverity, parseWildfires } from "../src/hazards/wildfires";
import { BRIEF_CRON, HAZARD_CRON, NEWS_CRON } from "../src/schedule";
import type { Site } from "../src/types";
import { createEnv, NOW } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const site = (fields: Partial<Site>): Site => ({
  id: 1,
  name: "Site",
  address: "",
  city: "",
  country: "US",
  lat: 0,
  lon: 0,
  area: "",
  keywords: "",
  priority: false,
  approximate: true,
  nws_zones: null,
  region: "",
  ...fields,
});

const MELROSE = site({ id: 1, name: "Paramount Pictures Studios", city: "Los Angeles", lat: 34.0838, lon: -118.3206, priority: true, nws_zones: "CAZ368,CAC037", region: "CA" });
const BURBANK = site({ id: 2, name: "Warner Bros. Studios Burbank", city: "Burbank", lat: 34.1487, lon: -118.3378, nws_zones: "CAZ368,CAC037", region: "CA" });
const BUREAU = site({ id: 3, name: "CBS News Washington Bureau", city: "Washington", lat: 38.9056, lon: -77.0457, priority: true, nws_zones: "DCZ001,DCC001", region: "DC" });
const LONDON = site({ id: 4, name: "Paramount UK (Camden)", city: "London", country: "GB", lat: 51.5413, lon: -0.1437, nws_zones: "" });
const MUMBAI = site({ id: 5, name: "Warner Bros. Discovery Mumbai", city: "Mumbai", country: "IN", lat: 19.065, lon: 72.865, nws_zones: "" });
const SITES = [MELROSE, BURBANK, BUREAU, LONDON, MUMBAI];

// ---------- samples in each service's format ----------

const NWS_POINT = JSON.stringify({
  properties: {
    forecastZone: "https://api.weather.gov/zones/forecast/CAZ368",
    county: "https://api.weather.gov/zones/county/CAC037",
    fireWeatherZone: "https://api.weather.gov/zones/fire/CAZ368",
    relativeLocation: { properties: { city: "Los Angeles", state: "CA" } },
  },
});

const nwsAlert = (id: string, fields: Record<string, unknown>) => ({
  id: `https://api.weather.gov/alerts/${id}`,
  type: "Feature",
  geometry: null,
  properties: {
    id,
    areaDesc: "Los Angeles County Mountains; Santa Monica Mountains",
    geocode: { UGC: ["CAZ368", "CAZ369"] },
    sent: "2026-11-12T09:00:00-08:00",
    ends: "2026-11-13T18:00:00-08:00",
    expires: "2026-11-12T21:00:00-08:00",
    status: "Actual",
    messageType: "Alert",
    severity: "Severe",
    event: "Red Flag Warning",
    headline: "Red Flag Warning issued November 12 at 9:00AM PST until November 13 at 6:00PM PST by NWS Los Angeles CA",
    description: "* WIND...Northeast 20 to 30 mph with gusts to 55 mph.\n* HUMIDITY...As low as 5 percent.",
    ...fields,
  },
});

const NWS_ALERTS = JSON.stringify({
  type: "FeatureCollection",
  features: [
    nwsAlert("urn:oid:red-flag", {}),
    nwsAlert("urn:oid:minor", { severity: "Minor", event: "Wind Advisory" }),
    nwsAlert("urn:oid:elsewhere", { geocode: { UGC: ["NYZ072"] } }),
    nwsAlert("urn:oid:test", { status: "Test" }),
  ],
});

const quake = (id: string, mag: number, lon: number, lat: number, place: string, tsunami = 0) => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [lon, lat, 12.4] },
  properties: { mag, place, time: Date.parse("2026-11-12T11:30:00Z"), url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, title: `M ${mag} - ${place}`, tsunami },
});

const USGS = JSON.stringify({
  type: "FeatureCollection",
  features: [
    quake("ci40001", 4.6, -118.26, 34.2, "5 km NE of Glendale, CA"),
    quake("ci40002", 3.0, -117.5, 34.0, "10 km S of Ontario, CA"),
    quake("ak40003", 6.4, -150.0, 61.0, "Southern Alaska"),
  ],
});

const fire = (id: string, name: string, lon: number, lat: number, acres: number, contained: number | null) => ({
  attributes: {
    IrwinID: `{${id}}`,
    IncidentName: name,
    IncidentSize: acres,
    PercentContained: contained,
    FireDiscoveryDateTime: Date.parse("2026-11-12T08:00:00Z"),
    POOState: "US-CA",
    POOCounty: "Los Angeles",
  },
  geometry: { x: lon, y: lat },
});

const WILDFIRES = JSON.stringify({
  geometryType: "esriGeometryPoint",
  features: [fire("A1", "Griffith", -118.3, 34.13, 240, 10), fire("B2", "Far Away", -120.34, 36.73, 9000, 20)],
});

const GDACS = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [72.9, 19.5] },
      properties: {
        eventtype: "TC", eventid: 1001350, name: "Tropical Cyclone ARNAV-26", alertlevel: "Red", episodealertlevel: "Red",
        iscurrent: "true", country: "India", fromdate: "2026-11-11T00:00:00", todate: "2026-11-14T00:00:00", Class: "Point_Centroid",
        url: { report: "https://www.gdacs.org/report.aspx?eventid=1001350&episodeid=3&eventtype=TC" },
        severitydata: { severitytext: "Hurricane/Typhoon > 74 mph (maximum wind speed of 157 km/h)" },
      },
    },
    { type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { eventtype: "TC", eventid: 1001350, alertlevel: "Red", iscurrent: "true", Class: "Poly_Cones" } },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [80.2, 15.8] },
      properties: { eventtype: "TC", eventid: 1001346, name: "Tropical Cyclone MURASU-26", alertlevel: "Red", iscurrent: "false", Class: "Point_Centroid" },
    },
  ],
});

const AIRCRAFT_7700 = JSON.stringify({
  ac: [{ hex: "a1b2c3", flight: "AAL123  ", r: "N123AA", t: "B738", lat: 34.18, lon: -118.36, alt_baro: 3200, squawk: "7700" }],
  msg: "No error",
  total: 1,
});

const TFRS = JSON.stringify([
  { notam_id: "6/7400", type: "VIP", facility: "ZLA", state: "CA", description: "BURBANK, CA, Friday, November 13, 2026 Local", creation_date: "11/13/2026" },
  { notam_id: "6/7401", type: "VIP", facility: "ZAU", state: "IL", description: "BURBANK, IL, Friday, November 13, 2026 Local", creation_date: "11/13/2026" },
  { notam_id: "6/7402", type: "SPACE OPERATIONS", facility: "ZLA", state: "CA", description: "BURBANK, CA, Friday", creation_date: "11/13/2026" },
]);

const ADVISORIES = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>travel.state.gov: Travel Advisories</title>
<item><title>India - Level 2: Exercise Increased Caution</title><link>https://travel.state.gov/content/tsg_aem/us/en/home/international-travel/travel-advisories/destination.ind.html</link><pubDate>Mon, 09 Nov 2026</pubDate></item>
<item><title>United Kingdom - Level 3: Reconsider Travel</title><link>https://travel.state.gov/destination.gbr.html</link><pubDate>Thu, 12 Nov 2026</pubDate></item>
<item><title>Iran - Level 4: Do Not Travel</title><link>https://travel.state.gov/destination.irn.html</link><pubDate>Fri, 23 Oct 2026</pubDate></item>
</channel></rss>`;

const CRT_HBOMAX = JSON.stringify([
  { issuer_name: "C=US, O=Let's Encrypt, CN=YE1", common_name: "hbomax--tvsignin.com", name_value: "*.hbomax--tvsignin.com\nhbomax--tvsignin.com", not_before: "2026-09-25T18:36:19" },
  { common_name: "play.hbomax.com", name_value: "play.hbomax.com", not_before: "2026-10-01T00:00:00" },
  { common_name: "hbomax-fans.pages.dev", name_value: "hbomax-fans.pages.dev", not_before: "2026-10-02T00:00:00" },
]);
const CRT_SKYDANCE = JSON.stringify([
  { common_name: "www.skydance-tours--charters.syso.asia", name_value: "www.skydance-tours--charters.syso.asia", not_before: "2026-10-17T11:54:34" },
  { common_name: "skydance-login-portal.com", name_value: "skydance-login-portal.com", not_before: "2026-11-10T00:00:00" },
]);

// ---------- rules and parsers ----------

describe("weather", () => {
  it("reads a site's zones and state", () => {
    expect(parseNwsPoint(NWS_POINT)).toEqual({ zones: ["CAZ368", "CAC037"], region: "CA" });
  });

  it("keeps warnings that bear on safety and leaves out the rest", () => {
    expect(weatherSeverity("Tornado Warning", "Extreme")).toBe("critical");
    expect(weatherSeverity("Red Flag Warning", "Severe")).toBe("high");
    expect(weatherSeverity("Flood Warning", "Moderate")).toBe("medium");
    expect(weatherSeverity("Winter Storm Watch", "Severe")).toBe("medium");
    expect(weatherSeverity("Wind Advisory", "Moderate")).toBeNull();
    expect(weatherSeverity("Freeze Watch", "Severe")).toBeNull();
    expect(weatherSeverity("High Surf Warning", "Moderate")).toBeNull();
    expect(weatherSeverity("Beach Hazards Statement", "Moderate")).toBeNull();
    expect(weatherSeverity("Shelter In Place Warning", "Moderate")).toBe("high");
    expect(weatherSeverity("Law Enforcement Warning", "Unknown")).toBe("high");
    expect(weatherSeverity("Civil Emergency Message", "Extreme")).toBe("critical");
  });

  it("raises severe warnings that cover sites and ignores minor, unrelated and test alerts", async () => {
    const items = await parseWeatherAlerts(NWS_ALERTS, SITES);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "nws",
      category: "hazard",
      severity: "high",
      incident: "Red Flag Warning, Los Angeles",
      site: "Paramount Pictures Studios",
      distanceMi: 0,
      expiresAt: "2026-11-13T18:00:00-08:00",
      ongoing: true,
    });
    expect(items[0]!.summary).toContain("2 company sites: Paramount Pictures Studios, Warner Bros. Studios Burbank");
    expect(items[0]!.summary).toContain("until 2026-11-14 02:00 UTC");
  });
});

describe("earthquakes", () => {
  it("scales the alert distance with magnitude", () => {
    expect(quakeSeverity(4.6, 8, false)).toBe("medium");
    expect(quakeSeverity(4.6, 30, false)).toBe("low");
    expect(quakeSeverity(4.6, 60, false)).toBeNull();
    expect(quakeSeverity(6.4, 50, false)).toBe("critical");
    expect(quakeSeverity(7.5, 250, false)).toBe("high");
    expect(quakeSeverity(2.6, 12, false)).toBeNull();
    expect(quakeSeverity(5.2, 80, true)).toBe("high");
  });

  it("keeps only quakes close enough to a site to matter", async () => {
    const items = await parseQuakes(USGS, SITES);
    expect(items.map((item) => [item.incident, item.severity, item.site])).toEqual([
      ["M4.6 earthquake, 5 km NE of Glendale, CA", "medium", "Warner Bros. Studios Burbank"],
    ]);
    expect(items[0]!.distanceMi).toBeGreaterThan(4);
    expect(items[0]!.distanceMi).toBeLessThan(6);
    expect(items[0]!.expiresAt).toBe("2026-11-15T11:30:00.000Z");
  });
});

describe("wildfires", () => {
  it("weighs distance against size", () => {
    expect(fireSeverity(3, 240)).toBe("critical");
    expect(fireSeverity(3, 20)).toBe("high");
    expect(fireSeverity(3, 2)).toBe("medium");
    expect(fireSeverity(12, 50)).toBe("low");
    expect(fireSeverity(25, 400)).toBeNull();
    expect(fireSeverity(40, 50_000)).toBeNull();
    expect(fireSeverity(4.7, 0)).toBeNull();
    expect(fireSeverity(1.5, 0)).toBe("low");
  });

  it("raises fires near sites, with a new alert if one escalates", async () => {
    const [item, ...rest] = await parseWildfires(WILDFIRES, SITES, NOW);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ incident: "Griffith Fire, CA", severity: "critical", site: "Warner Bros. Studios Burbank", ongoing: true });
    expect(item!.title).toBe("Griffith Fire: 240 acres, 10% contained");
    const bigger = await parseWildfires(WILDFIRES.replace("240", "20"), SITES, NOW);
    expect(bigger[0]!.id).not.toBe(item!.id);
  });

  it("reports a failed query instead of finding nothing", async () => {
    await expect(parseWildfires('{"error":{"code":400,"message":"Invalid query"}}', SITES, NOW)).rejects.toThrow("Invalid query");
  });
});

describe("global disasters", () => {
  it("rates by alert level and distance", () => {
    expect(disasterSeverity("Red", 50, 300)).toBe("critical");
    expect(disasterSeverity("Red", 200, 300)).toBe("high");
    expect(disasterSeverity("Orange", 50, 300)).toBe("high");
    expect(disasterSeverity("Orange", 200, 300)).toBe("medium");
  });

  it("uses each event's centre point and skips events that have ended", async () => {
    const items = await parseDisasters(GDACS, SITES, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ incident: "Tropical Cyclone ARNAV-26", severity: "critical", site: "Warner Bros. Discovery Mumbai", source: "gdacs" });
    expect(items[0]!.expiresAt).toBe("2026-11-15T00:00:00.000Z");
  });
});

describe("aircraft emergencies", () => {
  it("rates by code, distance and altitude", () => {
    expect(squawkSeverity("7500", 20, 30_000)).toBe("critical");
    expect(squawkSeverity("7700", 5, 3_000)).toBe("medium");
    expect(squawkSeverity("7700", 5, 35_000)).toBe("low");
    expect(squawkSeverity("7700", 30, 3_000)).toBeNull();
  });

  it("reports an emergency near a site", async () => {
    const [item] = await parseSquawks(AIRCRAFT_7700, "7700", SITES, NOW);
    expect(item).toMatchObject({ category: "physical", severity: "medium", incident: "AAL123 squawking 7700", site: "Warner Bros. Studios Burbank" });
    expect(item!.url).toBe("https://globe.adsb.lol/?icao=a1b2c3");
  });
});

describe("flight restrictions", () => {
  it("skips standing restrictions that began weeks ago", async () => {
    expect(restrictionStart("WASHINGTON, DC, Wednesday, September 3, 2025 UTC")).toBe(Date.UTC(2025, 8, 3));
    expect(restrictionStart("THURMONT, MD, Friday, November 13, 2026 through Sunday, November 15, 2026 Local")).toBe(Date.UTC(2026, 10, 13));
    expect(restrictionStart("NO DATE HERE")).toBeNull();
    const standing = JSON.stringify([{ notam_id: "5/1", type: "SECURITY", state: "CA", description: "BURBANK, CA, Wednesday, September 3, 2025 UTC" }]);
    expect(await parseRestrictions(standing, SITES, NOW)).toEqual([]);
  });

  it("matches the city and state of a site and skips space launches", async () => {
    const items = await parseRestrictions(TFRS, SITES, NOW);
    expect(items.map((item) => [item.incident, item.severity, item.site])).toEqual([
      ["Vip flight restriction, BURBANK", "medium", "Warner Bros. Studios Burbank"],
    ]);
    expect(items[0]!.summary).toContain("road closures");
  });
});

describe("travel advisories", () => {
  it("reads levels from the feed", () => {
    expect(parseAdvisories(ADVISORIES).map((a) => [a.country, a.level])).toEqual([
      ["India", 2],
      ["United Kingdom", 3],
      ["Iran", 4],
    ]);
  });

  it("alerts on Level 3 and above at first, then on any change", async () => {
    const advisories = parseAdvisories(ADVISORIES);
    const first = await advisoryChanges(advisories, SITES, {}, NOW);
    expect(first.items.map((item) => [item.incident, item.severity])).toEqual([["United Kingdom travel advisory", "medium"]]);
    expect(first.levels).toEqual({ GB: 3, IN: 2 });

    expect((await advisoryChanges(advisories, SITES, first.levels, NOW)).items).toEqual([]);

    const raised = await advisoryChanges(advisories, SITES, { GB: 3, IN: 1 }, NOW);
    expect(raised.items.map((item) => item.summary)).toEqual([
      "The US State Department rates India at Level 2 (Exercise Increased Caution), raised from Level 1. Company sites there: Warner Bros. Discovery Mumbai.",
    ]);
    const lowered = await advisoryChanges(advisories, SITES, { GB: 4, IN: 2 }, NOW);
    expect(lowered.items.map((item) => [item.title, item.severity])).toEqual([["United Kingdom - Level 3: Reconsider Travel", "low"]]);
  });
});

describe("lookalike domains", () => {
  it("finds the registered domain, including on free hosting platforms", () => {
    expect(registeredDomain("www.hbomax--tvsignin.com")).toBe("hbomax--tvsignin.com");
    expect(registeredDomain("login.hbomax-uk.co.uk")).toBe("hbomax-uk.co.uk");
    expect(registeredDomain("hbomax-fans.pages.dev")).toBe("hbomax-fans.pages.dev");
  });

  it("ignores official domains and flags phishing words", async () => {
    const found = findLookalikes(CRT_HBOMAX, "hbomax", ["hbomax.com"]);
    expect(found.map((entry) => [entry.domain, entry.words])).toEqual([
      ["hbomax--tvsignin.com", ["signin"]],
      ["hbomax-fans.pages.dev", []],
    ]);
    const item = await lookalikeItem(found[0]!, false);
    expect(item).toMatchObject({ category: "cyber", severity: "medium", incident: "Lookalike domain: hbomax--tvsignin.com", publishedAt: "2026-09-25T18:36:19Z" });
    expect(item!.summary).toContain('Words like "signin"');
    expect((await lookalikeItem(found[1]!, false))!.severity).toBe("low");
  });

  it("requires a phishing word for brand names that are also ordinary words", async () => {
    const found = findLookalikes(CRT_SKYDANCE, "skydance", ["skydance.com"]);
    const items = (await Promise.all(found.map((entry) => lookalikeItem(entry, true)))).filter(Boolean);
    expect(items.map((item) => item!.incident)).toEqual(["Lookalike domain: skydance-login-portal.com"]);
  });
});

// ---------- the whole run ----------

function stubHazardFeeds(overrides: Record<string, (url: URL) => Response> = {}) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requested.push(url.href);
    const override = overrides[url.hostname];
    if (override) return override(url);
    if (url.hostname === "api.weather.gov") {
      if (url.pathname.startsWith("/points/")) return new Response(NWS_POINT);
      return new Response(NWS_ALERTS);
    }
    if (url.hostname === "earthquake.usgs.gov") return new Response(USGS);
    if (url.hostname === "services3.arcgis.com") return new Response(WILDFIRES);
    if (url.hostname === "www.gdacs.org") return new Response(GDACS);
    if (url.hostname === "api.adsb.lol") return new Response(url.pathname.endsWith("7700") ? AIRCRAFT_7700 : '{"ac":[]}');
    if (url.hostname === "tfr.faa.gov") return new Response(TFRS);
    if (url.hostname === "travel.state.gov") return new Response(ADVISORIES);
    if (url.hostname === "crt.sh") {
      const query = url.searchParams.get("q");
      return new Response(query === "%hbomax%" ? CRT_HBOMAX : query === "%skydance%" ? CRT_SKYDANCE : "[]");
    }
    if (url.hostname === "api.sendgrid.com" || url.hostname === "api.twilio.com") return new Response("{}", { status: 202 });
    throw new Error(`unexpected request to ${url.hostname}`);
  });
  return requested;
}

async function envWithSites() {
  const env = createEnv();
  await saveSites(
    env.DB,
    [MELROSE, BURBANK, BUREAU, LONDON, MUMBAI].map(({ id, nws_zones, region, ...rest }) => rest),
    true,
  );
  return env;
}

describe("runHazards", () => {
  it("looks up weather zones once, raises each hazard once, and records the run", async () => {
    const env = await envWithSites();
    const requested = stubHazardFeeds();

    const run = await runHazards(env, NOW, true);
    expect(run.kind).toBe("hazards");
    expect(run.errors).toEqual([]);
    expect(run.sources.map((source) => [source.source, source.count, source.error])).toEqual([
      ["nws", 1, null],
      ["usgs", 1, null],
      ["wildfire", 1, null],
      ["gdacs", 1, null],
      ["aircraft", 1, null],
      ["faa_tfr", 1, null],
      ["travel_advisory", 1, null],
      ["domains", 2, null],
    ]);
    expect(run.newItems).toBe(9);

    // Only the three US sites needed a lookup; the zones are now stored.
    expect(requested.filter((url) => url.includes("/points/"))).toHaveLength(3);
    const sites = await listSites(env.DB);
    expect(sites.find((each) => each.name === "CBS News Washington Bureau")).toMatchObject({ nws_zones: "CAZ368,CAC037", region: "CA" });
    expect(sites.find((each) => each.name === "Paramount UK (Camden)")).toMatchObject({ nws_zones: "" });

    const alerts = await listAlerts(env.DB, { category: "hazard", limit: 50 });
    expect(alerts.map((alert) => alert.source).sort()).toEqual(["faa_tfr", "gdacs", "nws", "travel_advisory", "usgs", "wildfire"]);
    expect((await listAlerts(env.DB, { category: "cyber", limit: 50 })).map((alert) => [alert.title, alert.severity])).toEqual([
      ["Lookalike domain: hbomax--tvsignin.com", "medium"],
      ["Lookalike domain: hbomax-fans.pages.dev", "low"],
    ]);

    // The domain searches rotate and the advisory levels are remembered.
    expect(await getSetting(env.DB, "domain_rotation")).toBe("2");
    expect(JSON.parse((await getSetting(env.DB, "advisory_levels"))!)).toEqual({ GB: 3, IN: 2 });

    // A second run finds the same hazards and stores nothing new.
    const again = await runHazards(env, new Date(NOW.getTime() + 15 * 60_000), false);
    expect(again.newItems).toBe(0);
    expect(again.sources.map((source) => source.source)).not.toContain("domains");
    expect(requested.filter((url) => url.includes("/points/"))).toHaveLength(3);
  });

  it("closes hazards that lapse while keeping ongoing ones open", async () => {
    const env = await envWithSites();
    stubHazardFeeds();
    await runHazards(env, NOW, false);

    // Two days later the weather warning has ended and the quake window has passed;
    // the fire and the aircraft are no longer reported.
    stubHazardFeeds({
      "api.weather.gov": () => new Response('{"features":[]}'),
      "services3.arcgis.com": () => new Response('{"features":[]}'),
      "api.adsb.lol": () => new Response('{"ac":[]}'),
    });
    await runHazards(env, new Date(NOW.getTime() + 2 * 86_400_000), false);
    const open = await listAlerts(env.DB, { status: "new", limit: 50 });
    // The cyclone runs until the 14th plus a day, so it is still open.
    expect(open.map((alert) => alert.source).sort()).toEqual(["faa_tfr", "gdacs", "usgs"]);
    expect((await listAlerts(env.DB, { status: "expired", limit: 50 })).map((alert) => alert.source).sort()).toEqual([
      "aircraft",
      "nws",
      "wildfire",
    ]);
  });

  it("moves on to the next domain names when the certificate search fails", async () => {
    const env = await envWithSites();
    stubHazardFeeds({ "crt.sh": () => new Response("busy", { status: 502 }) });
    const run = await runHazards(env, NOW, true);
    expect(run.sources.find((source) => source.source === "domains")).toEqual({ source: "domains", count: 0, error: "HTTP 502" });
    expect(await getSetting(env.DB, "domain_rotation")).toBe("2");
  });

  it("keeps going when a feed fails", async () => {
    const env = await envWithSites();
    stubHazardFeeds({ "www.gdacs.org": () => new Response("down", { status: 503 }) });
    const run = await runHazards(env, NOW, false);
    expect(run.sources.find((source) => source.source === "gdacs")).toEqual({ source: "gdacs", count: 0, error: "HTTP 503" });
    expect(run.newItems).toBe(5);
  });

  it("texts about critical hazards like any other alert", async () => {
    const env = await envWithSites();
    Object.assign(env, { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15550000000", ALERT_SMS_TO: "+15551111111" });
    const texts: string[] = [];
    stubHazardFeeds({
      "api.twilio.com": () => new Response("{}", { status: 201 }),
    });
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === "api.twilio.com") texts.push(new URLSearchParams(await request.text()).get("Body") ?? "");
      return base(request);
    });
    await runHazards(env, NOW, false);
    expect(texts.sort()).toEqual([
      "Sentinel CRITICAL hazard: GDACS rates the Tropical Cyclone ARNAV-26 (India) at Red alert level: Hurricane/Typhoon > 74 mph (maximum wind speed of 157 km/h). Its centre is 30.1 miles from Warner Bros. Discovery Mumbai. https://sentinel.example",
      "Sentinel CRITICAL hazard: The Griffith Fire in Los Angeles County, CA has burned about 240 acres and is 10% contained. It is 2.5 miles from Warner Bros. Studios Burbank. https://sentinel.example",
    ]);
  });
});

describe("hazard API and schedule", () => {
  const auth = { Authorization: `Basic ${btoa("team:hunter2")}` };

  it("runs hazards on demand and reports the last hazard run", async () => {
    const env = await envWithSites();
    stubHazardFeeds();
    const response = await worker.fetch(new Request("https://sentinel.example/api/hazards/run", { method: "POST", headers: auth }), env);
    expect(response.status).toBe(200);
    const status = (await (await worker.fetch(new Request("https://sentinel.example/api/status", { headers: auth }), env)).json()) as any;
    expect(status.lastHazardRun).toMatchObject({ kind: "hazards", newItems: 9 });
    expect(status.lastRun).toBeNull();
  });

  it("runs each scheduled job on its own cron, and the crons match the config", async () => {
    const config = readFileSync("wrangler.toml", "utf8");
    expect(config).toContain(`crons = ["${NEWS_CRON}", "${HAZARD_CRON}", "${BRIEF_CRON}"]`);

    const env = await envWithSites();
    const requested = stubHazardFeeds();
    await worker.scheduled({ cron: HAZARD_CRON, scheduledTime: Date.parse("2026-11-12T12:22:00Z"), noRetry() {} } as ScheduledController, env);
    expect(requested.some((url) => url.includes("crt.sh"))).toBe(false);
    await worker.scheduled({ cron: HAZARD_CRON, scheduledTime: Date.parse("2026-11-12T13:07:00Z"), noRetry() {} } as ScheduledController, env);
    expect(requested.some((url) => url.includes("crt.sh"))).toBe(true);
  });
});
