import { describe, expect, it } from "vitest";
import { geomagneticScale, parseKp, parseMi5, parseQuote, parseRansomware, parseStorms, phishingHits } from "../src/intel";
import { brandBreaches, stormHazards, threatLevelHazards } from "../src/hazards/intelAlerts";
import { afterEach, vi } from "vitest";
import type { Site } from "../src/types";
import { createTestDb, NOW } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

// Samples in each feed's real format. The content is invented.
const MI5 = `<rss version="2.0"><channel><title>Threat Level</title><item><title>Current Threat Level: SEVERE</title>
<description>&lt;p&gt;The current national threat level is SEVERE. &amp;nbsp;The threat to Northern Ireland from Northern Ireland-related terrorism is SUBSTANTIAL.&lt;/p&gt;</description></item></channel></rss>`;

describe("ops board feeds", () => {
  it("reads the UK threat level", () => {
    expect(parseMi5(MI5)).toEqual({ level: "SEVERE", northernIreland: "SUBSTANTIAL" });
    expect(parseMi5("<rss></rss>")).toBeNull();
  });

  it("flags ransomware claims against the brands and nothing else", () => {
    const victims = parseRansomware(
      JSON.stringify([
        { victim: "Warner Bros. Games Montreal", group: "qilin", country: "CA", activity: "Media", discovered: "2026-11-12T10:00:00Z", url: "https://www.ransomware.live/id/abc", domain: "" },
        { victim: "Discovery Dental Group", group: "akira", country: "US", discovered: "2026-11-12T09:00:00Z", domain: "discoverydental.com" },
        { victim: "Acme Ltd", group: "lockbit", discovered: "2026-11-12T08:00:00Z", domain: "cbsnews.com" },
        { victim: "Bad link", group: "x", url: "https://evil.example/" },
      ]),
    );
    expect(victims.map((victim) => [victim.victim, victim.brand])).toEqual([
      ["Warner Bros. Games Montreal", true],
      ["Discovery Dental Group", false],
      ["Acme Ltd", true],
      ["Bad link", false],
    ]);
    expect(victims[3]!.url).toBe("https://www.ransomware.live/");
  });

  it("finds phishing URLs that use a brand name on someone else's domain", () => {
    const feed = ["https://hbomax-account-verify.pages.dev/login", "https://www.hbomax.com/", "https://skydance-fans.example/", "https://login-skydance.example/verify", "not a url", "https://bank.example/"].join("\n");
    expect(phishingHits(feed)).toEqual({
      total: 5,
      hits: [
        { url: "https://hbomax-account-verify.pages.dev/login", host: "hbomax-account-verify.pages.dev", brand: "hbomax" },
        { url: "https://login-skydance.example/verify", host: "login-skydance.example", brand: "skydance" },
      ],
    });
  });

  it("reads space weather, storms and share prices", () => {
    expect(parseKp(JSON.stringify([{ time_tag: "2026-11-17T12:00:00", Kp: 2.33 }, { time_tag: "2026-11-17T15:00:00", Kp: 6.0 }]))).toEqual({ kp: 6, scale: "G2", series: [2.33, 6], at: "2026-11-17T15:00:00Z" });
    expect([4.67, 5, 7.33, 9].map(geomagneticScale)).toEqual(["G0", "G1", "G3", "G5"]);
    expect(parseStorms(JSON.stringify({ activeStorms: [{ name: "Rafael", classification: "HU", intensity: "85", latitudeNumeric: 24.5, longitudeNumeric: -84.1 }] }))).toEqual([
      { name: "Rafael", kind: "Hurricane", windKt: 85, lat: 24.5, lon: -84.1, url: "https://www.nhc.noaa.gov/" },
    ]);
    const chart = { chart: { result: [{ meta: { regularMarketPrice: 105, chartPreviousClose: 100 }, indicators: { quote: [{ close: [100, null, 102, 105] }] } }] } };
    expect(parseQuote(JSON.stringify(chart), "PSKY", "Paramount Skydance")).toEqual({ symbol: "PSKY", name: "Paramount Skydance", price: 105, changePct: 5, series: [100, 102, 105] });
  });

  it("finds breaches of the company's own domains in the catalogue text", () => {
    const text = JSON.stringify([
      { Name: "CarMax", Title: "CarMax", Domain: "carmax.com", AddedDate: "2026-01-24T00:00:00Z", PwnCount: 10 },
      { Name: "HBOFans", Title: "HBO Fan Forum", Domain: "hbo.com", AddedDate: "2026-11-10T00:00:00Z", PwnCount: 1234 },
    ]);
    expect(brandBreaches(text)).toEqual([{ name: "HBO Fan Forum", domain: "hbo.com", added: "2026-11-10T00:00:00Z", count: 1234 }]);
  });

  it("alerts only on breaches added in the last 30 days", async () => {
    const { brandThreatHazards } = await import("../src/hazards/intelAlerts");
    const catalogue = JSON.stringify([
      { Name: "PlutoTV", Title: "Pluto TV", Domain: "pluto.tv", AddedDate: "2020-11-23T00:00:00Z", PwnCount: 3200000 },
      { Name: "HBOFans", Title: "HBO Fan Forum", Domain: "hbo.com", AddedDate: "2026-11-10T00:00:00Z", PwnCount: 1234 },
    ]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => new Response(String(input).includes("haveibeenpwned") ? catalogue : String(input).includes("ransomware") ? "[]" : ""));
    const items = await brandThreatHazards(NOW);
    expect(items.map((item) => item.title)).toEqual(["Data breach listed for hbo.com: HBO Fan Forum"]);
  });
});

describe("ops board alerts", () => {
  it("raises an alert only when the UK threat level changes", async () => {
    const db = createTestDb();
    let level = "SEVERE";
    vi.stubGlobal("fetch", async () => new Response(MI5.replaceAll("SEVERE", level)));
    const first = await threatLevelHazards(db, NOW);
    expect(first.items).toEqual([]);
    await first.commit!();
    expect((await threatLevelHazards(db, NOW)).items).toEqual([]);
    level = "CRITICAL";
    const raised = await threatLevelHazards(db, NOW);
    expect(raised.items.map((item) => [item.title, item.severity])).toEqual([["UK terrorism threat level raised to CRITICAL", "critical"]]);
  });

  it("raises tropical storms near a site", async () => {
    const miami: Site = { id: 1, name: "Doral office", address: "", city: "Doral", country: "US", lat: 25.82, lon: -80.36, area: "", keywords: "", priority: true, approximate: false, nws_zones: "", region: "" };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ activeStorms: [
      { name: "Rafael", classification: "HU", intensity: "85", latitudeNumeric: 24.5, longitudeNumeric: -84.1 },
      { name: "Far", classification: "TS", intensity: "40", latitudeNumeric: 15, longitudeNumeric: -40 },
    ] })));
    const items = await stormHazards([miami], NOW);
    expect(items.map((item) => [item.title, item.severity])).toEqual([["Hurricane Rafael, 251.0 miles from Doral office", "high"]]);
  });
});
