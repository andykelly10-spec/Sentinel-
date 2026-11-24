import { afterEach, describe, expect, it, vi } from "vitest";
import { avoidPolygons, avoidResponse, coveringSources, crimeResponse, MAX_ROWS, parseBox, routesResponse } from "../src/precog";
import {
  analyseRoute,
  avoidZones,
  compareRoutes,
  dayWeight,
  decodePolyline6,
  directionsLink,
  hourWeight,
  indexCrimes,
  placeName,
  readCrime,
  readOsrm,
  readValhalla,
  reasons,
} from "../public/precog.js";

afterEach(() => vi.unstubAllGlobals());

// A straight walk north along a meridian in Chicago, about 1.1 km.
const LINE = Array.from({ length: 11 }, (_, i) => [41.88 + i * 0.001, -87.63]);
const route = (coords = LINE, durationS = 840) => ({ coords, distanceM: 1110, durationS, kind: "osrm" });
const at = (lat: number, lon: number, extra: Record<string, unknown> = {}) => ({ lat, lon, date: Date.parse("2026-10-01"), hour: 22, weekend: false, type: "THEFT", violent: false, place: "", rate: 1, source: "chicago", ...extra });

function encode6(points: number[][]): string {
  let out = "";
  let last = [0, 0];
  for (const point of points) {
    for (const axis of [0, 1]) {
      const value = Math.round(point[axis]! * 1e6);
      let delta = value - Math.round(last[axis]! * 1e6);
      delta = delta < 0 ? ~(delta << 1) : delta << 1;
      while (delta >= 0x20) {
        out += String.fromCharCode((0x20 | (delta & 0x1f)) + 63);
        delta >>= 5;
      }
      out += String.fromCharCode(delta + 63);
    }
    last = point;
  }
  return out;
}

describe("reading police records", () => {
  it("tidies block names", () => {
    expect(placeName("005XX S STATE ST")).toBe("500 block of S State St");
    expect(placeName("0000X N STATE ST")).toBe("N State St");
    expect(placeName("22XX BLOCK OF WESTERN AVE")).toBe("2200 block of Western Ave");
    expect(placeName("1100 - 1199 BLOCK OF 14TH STREET NW")).toBe("1100 block of 14th Street NW");
    expect(placeName("REDACTED")).toBe("");
  });

  it("reads each city's format, with local hours and kinds of day", () => {
    const { crimes, sources } = readCrime({
      sources: [
        { id: "chicago", name: "Chicago Police", part: "crime", tz: "America/Chicago", days: 180, lag: "", maxRows: MAX_ROWS, error: null, body: [
          { date: "2026-11-14T23:30:00.000", primary_type: "ROBBERY", description: "ARMED - HANDGUN", block: "005XX S STATE ST", latitude: "41.87", longitude: "-87.62" },
          { date: "2026-11-13T12:00:00.000", primary_type: "THEFT", description: "RETAIL THEFT", block: "", latitude: "41.87", longitude: "-87.62" },
          { date: "2026-11-13T12:00:00.000", primary_type: "DECEPTIVE PRACTICE", latitude: "41.87", longitude: "-87.62" },
        ] },
        { id: "nyc", name: "NYPD", part: "complaints", tz: "America/New_York", days: 365, lag: "", maxRows: MAX_ROWS, error: null, body: [
          { cmplnt_fr_dt: "2026-07-05T00:00:00.000", cmplnt_fr_tm: "20:15:00", ofns_desc: "FELONY ASSAULT", latitude: "40.75", longitude: "-73.99" },
        ] },
        { id: "nyc", name: "NYPD", part: "shootings", tz: "America/New_York", days: 365, lag: "", maxRows: MAX_ROWS, error: null, body: [
          { occur_date: "2026-07-04T00:00:00.000", occur_time: "01:10:00", latitude: "40.75", longitude: "-73.99" },
        ] },
        { id: "la", name: "LAPD", part: "crime", tz: "America/Los_Angeles", days: 180, lag: "", maxRows: MAX_ROWS, error: null, body: [
          { date_occ: "2026-10-02T00:00:00.000", time_occ: "0742", nibr_description: "211 - PC - F - Robbery - 120", crime_against: "Property", hndrdth_lat: "34.05", hndrdth_lon: "-118.25", hndrdth_loc_chk: "700 S Figueroa St" },
        ] },
        { id: "seattle", name: "Seattle Police", part: "crime", tz: "America/Los_Angeles", days: 180, lag: "", maxRows: MAX_ROWS, error: null, body: [
          { offense_date: "2026-11-01T02:00:00.000", offense_sub_category: "ASSAULT OFFENSES", nibrs_crime_against_category: "PERSON", latitude: "REDACTED", longitude: "REDACTED" },
          { offense_date: "2026-11-01T02:00:00.000", offense_sub_category: "999", latitude: "47.6", longitude: "-122.3" },
          { offense_date: "2026-11-01T02:00:00.000", offense_sub_category: "LARCENY-THEFT", latitude: "-1.0", longitude: "-1.0" },
        ] },
        { id: "philadelphia", name: "Philadelphia Police", part: "crime", tz: "America/New_York", days: 180, lag: "", maxRows: MAX_ROWS, error: null, body: { rows: [
          { dispatch_date: "2026-11-01", dispatch_time: "17:20:00", text_general_code: "Thefts", location_block: "1500 BLOCK MARKET ST", point_x: -75.166, point_y: 39.952 },
        ] } },
        { id: "dc", name: "DC Metropolitan Police", part: "crime", tz: "America/New_York", days: 30, lag: "", maxRows: MAX_ROWS, error: null, body: { features: [
          // 2026-11-21 03:30 UTC is 22:30 on Friday the 20th in Washington.
          { attributes: { OFFENSE: "ROBBERY", METHOD: "GUN", REPORT_DAT: Date.parse("2026-11-21T03:30:00Z"), BLOCK: "1100 - 1199 BLOCK OF 14TH STREET NW" }, geometry: { x: -77.03, y: 38.9 } },
        ] } },
        { id: "uk", name: "UK police", part: "crime", tz: "Europe/London", days: 31, lag: "", maxRows: MAX_ROWS, error: null, body: [
          { category: "violent-crime", month: "2026-09", location: { latitude: "51.508", longitude: "-0.1364", street: { name: "On or near Ormond Yard" } } },
        ] },
        { id: "sf", name: "San Francisco Police", part: "crime", tz: "America/Los_Angeles", days: 180, lag: "", maxRows: MAX_ROWS, error: "HTTP 503", body: null },
      ],
    });
    const byType = Object.fromEntries(crimes.map((each: any) => [each.type, each]));
    expect(Object.keys(byType).sort()).toEqual(["FELONY ASSAULT", "ROBBERY", "ROBBERY (gun)", "Robbery", "Shooting", "Thefts", "violent crime"].sort());
    expect(byType.ROBBERY).toMatchObject({ hour: 23, weekend: true, violent: true, place: "500 block of S State St" });
    expect(byType["FELONY ASSAULT"]).toMatchObject({ hour: 20, violent: true, weekend: true });
    expect(byType.Shooting).toMatchObject({ hour: 1, violent: true });
    expect(byType.Robbery).toMatchObject({ hour: 7, violent: true, place: "700 S Figueroa St" });
    expect(byType.Thefts).toMatchObject({ hour: 17, violent: false, place: "1500 block of Market St" });
    expect(byType["ROBBERY (gun)"]).toMatchObject({ hour: 22, weekend: false, place: "1100 block of 14th Street NW" });
    expect(byType["violent crime"]).toMatchObject({ hour: null, weekend: null, violent: true, place: "Ormond Yard", lon: -0.1364 });
    expect(sources.find((source: any) => source.id === "sf")).toMatchObject({ error: "HTTP 503", count: 0 });
    expect(sources.find((source: any) => source.id === "chicago")).toMatchObject({ count: 1, days: 180, tz: "America/Chicago" });
    expect(byType.ROBBERY.rate).toBeCloseTo(30 / 180);
  });

  it("measures the window from the records when a source's page was full", () => {
    const body = Array.from({ length: 10 }, (_, i) => ({ date: `2026-11-${String(10 + i).padStart(2, "0")}T12:00:00.000`, primary_type: "BATTERY", latitude: "41.88", longitude: "-87.63" }));
    const { sources, crimes } = readCrime({ sources: [{ id: "chicago", name: "Chicago", part: "crime", days: 180, maxRows: 10, error: null, body }] });
    expect(sources[0]).toMatchObject({ days: 9, truncated: true });
    expect(crimes[0].rate).toBeCloseTo(30 / 9);
  });
});

describe("routes", () => {
  it("reads OSRM and Valhalla answers", () => {
    expect(readOsrm({ routes: [{ distance: 900, duration: 700, geometry: { coordinates: [[-87.63, 41.88], [-87.63, 41.89]] } }] })).toEqual([
      { coords: [[41.88, -87.63], [41.89, -87.63]], distanceM: 900, durationS: 700, kind: "osrm" },
    ]);
    const points = [[41.88, -87.63], [41.881234, -87.629876], [41.9, -87.6]];
    expect(decodePolyline6(encode6(points))).toEqual(points);
    const [detour] = readValhalla({ trip: { legs: [{ shape: encode6(points) }], summary: { length: 2.5, time: 1800 } } });
    expect(detour).toMatchObject({ distanceM: 2500, durationS: 1800, kind: "avoid", coords: points });
    expect(readValhalla({ error: "no route" })).toEqual([]);
  });

  it("links to Google Maps directions through points on the route", () => {
    const link = new URL(directionsLink(route(), "walk"));
    expect(link.searchParams.get("origin")).toBe("41.88000,-87.63000");
    expect(link.searchParams.get("destination")).toBe("41.89000,-87.63000");
    expect(link.searchParams.get("travelmode")).toBe("walking");
    expect(link.searchParams.get("waypoints")!.split("|")).toHaveLength(8);
  });
});

describe("prediction", () => {
  it("time and day weights average 1, so totals stay comparable", () => {
    const overDay = Array.from({ length: 24 }, (_, hour) => hourWeight(5, hour)).reduce((a, b) => a + b, 0) / 24;
    expect(overDay).toBeCloseTo(1, 6);
    expect(hourWeight(22, 22)).toBeGreaterThan(hourWeight(22, 20));
    expect(hourWeight(23, 1)).toBeCloseTo(hourWeight(1, 23));
    expect(hourWeight(null, 3)).toBe(1);
    const weekday = (5 * dayWeight(false, false) + 2 * dayWeight(true, false)) / 7;
    const weekend = (5 * dayWeight(false, true) + 2 * dayWeight(true, true)) / 7;
    expect(weekday).toBeCloseTo(1, 6);
    expect(weekend).toBeCloseTo(1, 6);
  });

  it("counts incidents near the route, weighting violence and the planned hour", () => {
    const crimes = [
      at(41.884, -87.6305), // ~40 m off the line
      at(41.886, -87.6303, { violent: true, type: "BATTERY" }),
      at(41.886, -87.62), // ~830 m away
    ];
    const index = indexCrimes(crimes);
    const night = analyseRoute(route(), { index, mode: "walk", hour: 22, weekend: false });
    const morning = analyseRoute(route(), { index, mode: "walk", hour: 9, weekend: false });
    expect(night.crimes).toHaveLength(2);
    expect(night.violentPerMonth).toBe(1);
    expect(night.score).toBeGreaterThan(morning.score * 5);
    expect(night.peak).toBe("21:00–00:00");
    // Driving looks closer to the road.
    expect(analyseRoute(route(), { index, mode: "drive", hour: 22, weekend: false }).crimes).toHaveLength(2);
    expect(analyseRoute(route(), { index: indexCrimes([at(41.884, -87.6295 + 0.0008)]), mode: "drive", hour: 22, weekend: false }).crimes).toHaveLength(0);
  });

  it("adds live Sentinel alerts near the route at every hour", () => {
    const index = indexCrimes([]);
    const alerts = [
      { lat: 41.885, lon: -87.631, severity: "high", title: "Shooting reported" },
      { lat: 41.885, lon: -87.6, severity: "critical", title: "Far away" },
    ];
    const analysed = analyseRoute(route(), { index, mode: "walk", hour: 3, weekend: false, alerts: alerts as any });
    expect(analysed.live).toEqual([expect.objectContaining({ title: "Shooting reported", severity: "high" })]);
    expect(analysed.score).toBe(20);
    expect(analysed.byHour.every((value: number) => value === 20)).toBe(true);
    expect(reasons(analysed, 3).join(" ")).toContain("Live high alert");
  });

  it("finds hotspots and explains the route", () => {
    const cluster = Array.from({ length: 8 }, (_, i) => at(41.8851 + i * 0.00001, -87.6301, { type: "ROBBERY", violent: i < 3, place: "1200 block of S State St", hour: 21 + (i % 3) }));
    const analysed = analyseRoute(route(), { index: indexCrimes(cluster), mode: "walk", hour: 22, weekend: false });
    expect(analysed.hotspots).toHaveLength(1);
    expect(analysed.hotspots[0]).toMatchObject({ place: "1200 block of S State St", perMonth: 8, peak: "21:00–00:00" });
    const text = reasons(analysed, 22).join("\n");
    expect(text).toContain("About 8 incidents a month recorded within 80 m, 3 of them violent");
    expect(text).toContain("Hotspot at 1200 block of S State St");
  });

  it("recommends the safest route unless it takes far longer", () => {
    const mk = (score: number, durationS: number, kind = "osrm") => ({ ...route(LINE, durationS), kind, score, letter: String(score) });
    const [first, ...rest] = compareRoutes([mk(80, 600), mk(30, 700), mk(5, 2000)], "walk");
    expect(first).toMatchObject({ score: 30, tags: ["Recommended"], extraMinutes: 2 });
    expect(rest.map((each: any) => each.tags)).toEqual([["Safest"], ["Fastest"]]);
    expect(compareRoutes([mk(10, 600)], "walk")[0].tags).toEqual(["Only route found"]);
    expect(compareRoutes([mk(80, 600), mk(20, 650, "avoid")], "drive")[0].tags).toEqual(["Recommended", "Safest", "Avoids hotspots"]);
  });

  it("builds zones to avoid from hotspots, never at the start or end", () => {
    const spots = [
      { lat: 41.8801, lon: -87.63, weight: 50 }, // at the start
      { lat: 41.885, lon: -87.63, weight: 40 },
      { lat: 41.8851, lon: -87.63, weight: 30 }, // same place as the last
      { lat: 41.887, lon: -87.63, weight: 20 },
    ];
    const zones = avoidZones([{ hotspots: spots }], { lat: 41.88, lon: -87.63 }, { lat: 41.89, lon: -87.63 });
    expect(zones).toEqual([
      { lat: 41.885, lon: -87.63, radiusM: 110 },
      { lat: 41.887, lon: -87.63, radiusM: 110 },
    ]);
  });
});

describe("the worker side", () => {
  it("accepts only city-sized boxes", () => {
    expect(parseBox("41.87,-87.64,41.9,-87.6")).toEqual([41.87, -87.64, 41.9, -87.6]);
    expect(parseBox("41.9,-87.64,41.87,-87.6")).toBeNull();
    expect(parseBox("40,-88,41,-87")).toBeNull();
    expect(parseBox("a,b,c,d")).toBeNull();
    expect(coveringSources([41.87, -87.64, 41.9, -87.6]).map((source) => source.id)).toEqual(["chicago"]);
    expect(coveringSources([51.5, -0.14, 51.52, -0.11]).map((source) => source.id)).toEqual(["uk"]);
    expect(coveringSources([48.85, 2.3, 48.87, 2.36])).toEqual([]);
  });

  it("passes the sources' answers on in one document, without parsing them", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("5ucz-vwe8")) return new Response("<html>busy</html>", { status: 200 });
      return new Response(`[{"cmplnt_fr_dt":"2026-07-05T00:00:00.000","ofns_desc":"ROBBERY","latitude":"40.75","longitude":"-73.99"}]`);
    });
    const response = await crimeResponse([40.74, -74.0, 40.76, -73.98], new Date("2026-11-24T12:00:00Z"));
    const body = (await response.json()) as any;
    expect(body.sources.map((source: any) => [source.id, source.part, source.error])).toEqual([
      ["nyc", "complaints", null],
      ["nyc", "shootings", "Unexpected answer"],
    ]);
    expect(body.sources[0].body[0].ofns_desc).toBe("ROBBERY");
    expect(body.sources[1].body).toBeNull();
    expect(new URL(requested[0]!).searchParams.get("$where")).toContain("cmplnt_fr_dt > '2025-11-24T12:00:00'");
    expect(readCrime(body).crimes).toHaveLength(1);
  });

  it("checks route requests before asking the routing service", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(`{"routes":[]}`);
    });
    expect((await routesResponse(new URLSearchParams({ from: "41.88,-87.63", to: "41.88,-87.63", mode: "walk" }))).status).toBe(400);
    expect((await routesResponse(new URLSearchParams({ from: "41.88,-87.63", to: "42.2,-87.63", mode: "walk" }))).status).toBe(400);
    expect((await routesResponse(new URLSearchParams({ from: "41.88,-87.63", to: "41.89,-87.62", mode: "fly" }))).status).toBe(400);
    expect(requested).toHaveLength(0);
    const ok = await routesResponse(new URLSearchParams({ from: "41.88,-87.63", to: "41.89,-87.62", mode: "drive" }));
    expect(ok.status).toBe(200);
    expect(requested[0]).toBe("https://routing.openstreetmap.de/routed-car/route/v1/driving/-87.63,41.88;-87.62,41.89?alternatives=3&overview=full&geometries=geojson&steps=false");
  });

  it("asks Valhalla for a detour that excludes squares around the hotspots", async () => {
    const polygons = avoidPolygons([{ lat: 41.885, lon: -87.63, radiusM: 111.32 }, { lat: "x" }]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]![0]![1]).toBeCloseTo(41.884, 4);
    expect(polygons[0]![0]).toEqual(polygons[0]![4]);
    let sent: any = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(`{"trip":{}}`);
    });
    const response = await avoidResponse({ from: { lat: 41.88, lon: -87.63 }, to: { lat: 41.89, lon: -87.63 }, mode: "walk", zones: [{ lat: 41.885, lon: -87.63 }] });
    expect(response.status).toBe(200);
    expect(sent).toMatchObject({ costing: "pedestrian", directions_type: "none" });
    expect(sent.exclude_polygons).toHaveLength(1);
    expect((await avoidResponse({ from: { lat: 41.88, lon: -87.63 }, to: { lat: 41.89, lon: -87.63 }, mode: "walk", zones: [] })).status).toBe(400);
  });
});
