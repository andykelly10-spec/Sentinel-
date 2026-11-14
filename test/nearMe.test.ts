import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runHazards } from "../src/hazards";
import { callsToItems, FEEDS, seattleSeverity, sfPoliceSeverity, zonedToIso, type DispatchCall } from "../src/hazards/dispatch";
import { nixlePostsToItems, nixleSeverity, parseAge, parseNixleZip } from "../src/hazards/nixle";
import { activeLocation, mySite, parseNominatim, updateMyLocation, validUpdate, withMyLocation, type MyLocation } from "../src/me";
import { searchAreas } from "../src/sources";
import type { Site } from "../src/types";
import { createEnv, NOW } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://sentinel.example";
const auth = { Authorization: `Basic ${btoa("x:hunter2")}` };
// About one mile, in degrees of latitude.
const MILE = 1 / 69.05;

// Sample payloads in each service's real format. The content is invented.
const NOMINATIM = JSON.stringify({
  display_name: "Downtown Santa Monica, Santa Monica, Los Angeles County, California, 90401, United States",
  address: {
    quarter: "Downtown Santa Monica",
    city: "Santa Monica",
    county: "Los Angeles County",
    state: "California",
    postcode: "90401",
    country: "United States",
    country_code: "us",
  },
});

const NWS_POINT = JSON.stringify({
  properties: {
    forecastZone: "https://api.weather.gov/zones/forecast/CAZ368",
    county: "https://api.weather.gov/zones/county/CAC037",
    fireWeatherZone: "https://api.weather.gov/zones/fire/CAZ368",
    relativeLocation: { properties: { state: "CA" } },
  },
});

const nixleEntry = (id: number, level: string, agency: string, age: string, text: string) => `
  <li id="pub_${id}">
    <div class="wrapper"><div class="wire_priority"><span class="priority ${level}">${level}</span></div>
    <div class="wire_content">
      <div class="logo"><a href="/agency"><img src="x.png" alt="${agency}"/></a></div>
      <h2 class="certified"><a href="/agency">${agency}</a></h2>
      <p class="time">Entered: ${age}</p>
      <p>${text} <a href="https://nixle.us/ABC${id}">More&nbsp;&raquo;</a></p>
    </div></div>
  </li>`;

const NIXLE_ZIP = `<html><body><ol id="wire" class="clearfix">
${nixleEntry(1, "alert", "Santa Monica Police Department", "35 minutes ago", "Barricaded suspect on 4th Street &amp; Arizona. Residents shelter in place.")}
${nixleEntry(2, "advisory", "City Emergency Management", "2 hours, 10 minutes ago", "Police activity near the pier. Please avoid the area.")}
${nixleEntry(3, "alert", "Parks and Recreation", "1 hour ago", "Winter program registration opens today!")}
${nixleEntry(4, "advisory", "County Sheriff", "2 days, 20 hours ago", "Shooting investigation in another town")}
</ol></body></html>`;

const SF = { lat: 37.7749, lon: -122.4194 };
const sfSite: Site = {
  id: 1, name: "SF office", address: "", city: "San Francisco", country: "US", lat: SF.lat, lon: SF.lon,
  area: "San Francisco", keywords: "", priority: true, approximate: false, nws_zones: "", region: "CA",
};

function location(fields: Partial<MyLocation> = {}): MyLocation {
  return {
    lat: 34.0195, lon: -118.4912, accuracyM: 20, radiusMi: 1, updatedAt: NOW.toISOString(),
    placeLat: 34.0195, placeLon: -118.4912, label: "Downtown Santa Monica, Santa Monica, California",
    neighbourhood: "Downtown Santa Monica", city: "Santa Monica", region: "California", postcode: "90401",
    country: "US", nwsZones: "CAZ368,CAC037", ...fields,
  };
}

function stubServices(extra: Record<string, (url: URL) => Response> = {}) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    requested.push(url.href);
    if (extra[url.hostname]) return extra[url.hostname]!(url);
    if (url.hostname === "nominatim.openstreetmap.org") return new Response(NOMINATIM);
    if (url.hostname === "api.weather.gov") return new Response(url.pathname.startsWith("/points/") ? NWS_POINT : '{"features":[]}');
    if (url.hostname === "local.nixle.com") return new Response(NIXLE_ZIP);
    // Every other hazard feed answers with nothing to report.
    if (url.hostname === "earthquake.usgs.gov") return new Response('{"features":[]}');
    if (url.hostname === "services3.arcgis.com") return new Response('{"features":[]}');
    if (url.hostname === "www.gdacs.org") return new Response('{"features":[]}');
    if (url.hostname === "api.adsb.lol") return new Response('{"ac":[]}');
    if (url.hostname === "tfr.faa.gov") return new Response("[]");
    throw new Error(`unexpected request to ${url.hostname}`);
  });
  return requested;
}

describe("your location", () => {
  it("reads the place name and ZIP code from a Nominatim lookup", () => {
    expect(parseNominatim(NOMINATIM)).toEqual({
      label: "Downtown Santa Monica, Santa Monica, California",
      neighbourhood: "Downtown Santa Monica",
      city: "Santa Monica",
      region: "California",
      postcode: "90401",
      country: "US",
    });
  });

  it("accepts only real coordinates and a listed radius", () => {
    expect(validUpdate({ lat: 34, lon: -118, radiusMi: 5, accuracyM: 12.4 })).toEqual({ lat: 34, lon: -118, radiusMi: 5, accuracyM: 12 });
    expect(validUpdate({ lat: 34, lon: -118, radiusMi: 7 })?.radiusMi).toBe(1);
    expect(validUpdate({ lat: 95, lon: 0 })).toBeNull();
    expect(validUpdate({ lat: "34", lon: -118 })).toBeNull();
    expect(validUpdate(null)).toBeNull();
  });

  it("looks the place up once per move and rounds the position to about 100 m", async () => {
    const env = createEnv();
    const requested = stubServices();
    const first = await updateMyLocation(env.DB, { lat: 34.019512, lon: -118.491234, radiusMi: 2 }, NOW);
    expect(first.moved).toBe(true);
    expect(first.location).toMatchObject({ lat: 34.02, lon: -118.491, radiusMi: 2, postcode: "90401", city: "Santa Monica", nwsZones: "CAZ368,CAC037" });

    // A few hundred metres later: no new lookup, and the radius is kept.
    const later = new Date(NOW.getTime() + 60_000);
    const second = await updateMyLocation(env.DB, { lat: 34.0215, lon: -118.4935 }, later);
    expect(second.moved).toBe(false);
    expect(second.location).toMatchObject({ lat: 34.022, postcode: "90401", radiusMi: 2 });
    expect(requested.filter((url) => url.includes("nominatim"))).toHaveLength(1);

    // Watching lapses 12 hours after the last update.
    expect(await activeLocation(env.DB, new Date(later.getTime() + 11 * 3_600_000))).not.toBeNull();
    expect(await activeLocation(env.DB, new Date(later.getTime() + 13 * 3_600_000))).toBeNull();
  });

  it("is checked as one more site, and its city is searched first for local news", () => {
    const me = location();
    const sites = withMyLocation([sfSite], me);
    expect(sites.map((site) => site.name)).toEqual(["SF office", "Your location"]);
    expect(mySite(me)).toMatchObject({ area: "Santa Monica", keywords: "Downtown Santa Monica", radiusMi: 1, priority: true });
    expect(searchAreas({ sites: [sfSite], focusArea: "Santa Monica" })).toEqual(["Santa Monica", "San Francisco"]);
    expect(withMyLocation([sfSite], null)).toEqual([sfSite]);
  });

  it("is set, reported and cleared through the API, and only from the dashboard itself", async () => {
    const env = createEnv();
    stubServices();
    const post = (path: string, body: unknown, origin = ORIGIN) =>
      worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);

    expect((await post("/api/me", { lat: 34.0195, lon: -118.4912 }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/me", { lat: "x" })).status).toBe(400);

    const saved = await post("/api/me", { lat: 34.0195, lon: -118.4912, radiusMi: 0.5 });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { location: MyLocation; checking: boolean };
    expect(body.checking).toBe(true);
    expect(body.location).toMatchObject({ city: "Santa Monica", radiusMi: 0.5 });

    const status = (await (await worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: auth }), env)).json()) as { me: MyLocation | null };
    expect(status.me?.postcode).toBe("90401");

    expect((await post("/api/me/off", {})).status).toBe(200);
    const after = (await (await worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: auth }), env)).json()) as { me: MyLocation | null };
    expect(after.me).toBeNull();
  });
});

describe("city 911 dispatch", () => {
  it("converts Pacific wall-clock times to UTC across daylight saving", () => {
    expect(zonedToIso("2026-11-12T04:00:00.000", "America/Los_Angeles")).toBe("2026-11-12T12:00:00.000Z");
    expect(zonedToIso("2026-07-01T10:00:00.000", "America/Los_Angeles")).toBe("2026-07-01T17:00:00.000Z");
    expect(zonedToIso("not a time", "America/Los_Angeles")).toBeNull();
  });

  it("keeps only calls that put people at risk", () => {
    expect(seattleSeverity("Scenes Of Violence 7")).toBe("high");
    expect(seattleSeverity("Fire in Building")).toBe("high");
    expect(seattleSeverity("HazMat Reduced")).toBe("medium");
    expect(seattleSeverity("Aid Response")).toBeNull();
    expect(seattleSeverity("Auto Fire Alarm")).toBeNull();
    expect(sfPoliceSeverity("SHOOTING")).toBe("high");
    expect(sfPoliceSeverity("PERSON W/GUN")).toBe("high");
    expect(sfPoliceSeverity("ROBBERY")).toBe("medium");
    expect(sfPoliceSeverity("AGG ASSAULT / ADW DV")).toBeNull();
    expect(sfPoliceSeverity("TRAFFIC STOP")).toBeNull();
  });

  it("reads both cities' feeds", () => {
    const seattle = FEEDS.find((feed) => feed.id === "seattle")!;
    expect(
      seattle.parse(JSON.stringify([{ address: "8TH AVE / BELL ST", type: "Fire in Building", datetime: "2026-11-12T03:40:00.000", latitude: "47.618027", longitude: "-122.340494", incident_number: "F1" }])),
    ).toEqual([{ key: "seattle:F1", type: "Fire in Building", address: "8TH AVE / BELL ST", lat: 47.618027, lon: -122.340494, time: "2026-11-12T11:40:00.000Z" }]);

    const sf = FEEDS.find((feed) => feed.id === "sf_police")!;
    const row = { cad_number: "263", received_datetime: "2026-11-12T03:50:00.000", call_type_final_desc: "SHOOTING", intersection_name: "18TH ST \\ DOLORES ST", intersection_point: { type: "Point", coordinates: [-122.4261, 37.7614] }, sensitive_call: false };
    expect(sf.parse(JSON.stringify([row, { ...row, cad_number: "264", sensitive_call: true }]))).toEqual([
      { key: "sf:263", type: "SHOOTING", address: "18TH ST & DOLORES ST", lat: 37.7614, lon: -122.4261, time: "2026-11-12T11:50:00.000Z" },
    ]);
  });

  it("raises serious calls within each site's radius, and lesser calls only very close", async () => {
    const sf = FEEDS.find((feed) => feed.id === "sf_police")!;
    const me = mySite(location({ lat: SF.lat + 3 * MILE, lon: SF.lon, radiusMi: 0.5 }));
    const recent = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    const call = (key: string, type: string, northMiles: number, time = recent): DispatchCall => ({
      key, type, address: "MARKET ST & 5TH ST", lat: SF.lat + northMiles * MILE, lon: SF.lon, time,
    });
    const items = await callsToItems(
      sf,
      [
        call("a", "SHOOTING", 0.3),
        call("a", "SHOOTING", 0.3),
        call("b", "ROBBERY", 0.8),
        call("c", "ROBBERY", 0.2),
        call("d", "PERSON W/GUN", 1.8),
        call("e", "PERSON W/GUN", 2.8),
        call("f", "SHOOTING", 0.1, new Date(NOW.getTime() - 4 * 3_600_000).toISOString()),
        call("g", "TRAFFIC STOP", 0),
      ],
      [sfSite, me],
      NOW,
    );
    expect(items.map((item) => [item.title, item.severity, item.site, item.distanceMi])).toEqual([
      ["Shooting at Market St & 5th St", "high", "SF office", 0.3],
      ["Robbery at Market St & 5th St", "medium", "SF office", 0.2],
      ["Person W/Gun at Market St & 5th St", "high", "Your location", 0.2],
    ]);
    expect(items[0]!.summary).toContain("San Francisco Police Department was dispatched to a shooting call");
    expect(items[0]!.expiresAt).toBe(new Date(Date.parse(recent) + 3 * 3_600_000).toISOString());
  });
});

describe("Nixle", () => {
  it("reads posts and their age from a ZIP code page", () => {
    expect(parseAge("Entered: 2 days, 20 hours ago")).toBe((2 * 24 + 20) * 3_600_000);
    expect(parseAge("Entered: 35 minutes ago")).toBe(35 * 60_000);
    expect(parseAge("Entered: sometime")).toBeNull();
    const posts = parseNixleZip(NIXLE_ZIP);
    expect(posts).toHaveLength(4);
    expect(posts[0]).toEqual({
      id: "1",
      level: "alert",
      agency: "Santa Monica Police Department",
      text: "Barricaded suspect on 4th Street & Arizona. Residents shelter in place.",
      url: "https://nixle.us/ABC1",
      ageMs: 35 * 60_000,
    });
  });

  it("judges posts by what they say, not by the agency's label", async () => {
    expect(nixleSeverity("Registration opens today")).toBeNull();
    expect(nixleSeverity("Shots fired near Main St")).toBe("high");
    expect(nixleSeverity("Road closed due to police activity")).toBe("medium");
    const items = await nixlePostsToItems(parseNixleZip(NIXLE_ZIP), location(), NOW);
    expect(items.map((item) => [item.title, item.severity, item.site, item.lat, item.distanceMi])).toEqual([
      ["Barricaded suspect on 4th Street & Arizona. Residents shelter in place.", "high", "Your location", null, null],
      ["Police activity near the pier. Please avoid the area.", "medium", "Your location", null, null],
    ]);
    expect(items[0]!.publishedAt).toBe(new Date(NOW.getTime() - 35 * 60_000).toISOString());
  });
});

describe("hazard run near you", () => {
  it("checks Nixle for your ZIP code and the 911 feed for your city", async () => {
    const env = createEnv();
    const recent = "2026-11-12T03:50:00.000";
    const requested = stubServices({
      "data.sfgov.org": () =>
        new Response(JSON.stringify([{ cad_number: "9", received_datetime: recent, call_type_final_desc: "SHOTS FIRED", intersection_name: "MARKET ST \\ 5TH ST", intersection_point: { type: "Point", coordinates: [SF.lon, SF.lat + 0.2 * MILE] } }])),
    });
    await updateMyLocation(env.DB, { lat: SF.lat, lon: SF.lon, radiusMi: 1 }, NOW);

    const run = await runHazards(env, NOW, false);
    expect(run.errors).toEqual([]);
    expect(run.sources.filter((source) => ["dispatch", "nixle"].includes(source.source))).toEqual([
      { source: "dispatch", count: 1, error: null },
      { source: "nixle", count: 2, error: null },
    ]);
    expect(requested).toContain("https://local.nixle.com/zipcode/90401/");
    expect(requested.some((url) => url.startsWith("https://data.seattle.gov"))).toBe(false);
  });

  it("skips Nixle when nobody is watching a location", async () => {
    const env = createEnv();
    const requested = stubServices();
    const run = await runHazards(env, NOW, false);
    expect(run.sources.map((source) => source.source)).not.toContain("nixle");
    expect(requested.some((url) => url.includes("nixle"))).toBe(false);
  });
});
