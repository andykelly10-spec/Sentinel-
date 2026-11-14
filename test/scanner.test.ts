import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { broadcastifyName, countyIds, parseCounty } from "../src/scanner";
import { createEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

// Trimmed from the real pages; the counts are invented.
const STATE_PAGE = `<div class="listen-loc-grid listen-loc-grid--counties">
<a class="portal-grid-card" href="/listen/ctid/201"><span class="portal-grid-card-name">Los Angeles</span><span class="portal-grid-card-count">98</span></a>
<a class="portal-grid-card" href="/listen/ctid/216"><span class="portal-grid-card-name">Sacramento</span><span class="portal-grid-card-count">20</span></a></div>
<table><tr><td><a href="/listen/feed/1">LAPD</a></td><td><a href="/listen/ctid/201">Los Angeles</a></td></tr></table>`;

const NOMINATIM = (address: Record<string, string>) => JSON.stringify({ address });
const auth = { Authorization: `Basic ${btoa("x:hunter2")}` };

describe("police scanner links", () => {
  it("reads the county list from a Broadcastify state page", () => {
    expect(countyIds(STATE_PAGE)).toEqual({ losangeles: 201, sacramento: 216 });
  });

  it("works out the US county, and Broadcastify's names for New York City and DC", () => {
    expect(parseCounty(NOMINATIM({ county: "Los Angeles County", "ISO3166-2-lvl4": "US-CA", country_code: "us" }))).toEqual({ state: "CA", county: "Los Angeles County" });
    expect(parseCounty(NOMINATIM({ city: "Washington", "ISO3166-2-lvl4": "US-DC", country_code: "us" }))).toEqual({ state: "DC", county: "District of Columbia" });
    expect(parseCounty(NOMINATIM({ county: "Camden", country_code: "gb" }))).toBeNull();
    expect(broadcastifyName("NY", "Kings County")).toBe("newyorkcity");
    expect(broadcastifyName("DC", "District of Columbia")).toBe("washingtondc");
    expect(broadcastifyName("NY", "Albany County")).toBe("albany");
  });

  it("links to the county's feeds, falls back to the state's, and looks each up once", async () => {
    const requested: string[] = [];
    let stateReply = new Response(STATE_PAGE);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      requested.push(url);
      if (url.includes("nominatim")) return new Response(NOMINATIM({ county: url.includes("lat=34.18") ? "Los Angeles County" : "Yolo County", "ISO3166-2-lvl4": "US-CA", country_code: "us" }));
      return stateReply;
    });
    const env = createEnv();
    const ask = async (lat: number, lon: number) =>
      (await (await worker.fetch(new Request(`https://sentinel.example/api/scanner?lat=${lat}&lon=${lon}`, { headers: auth }), env)).json()) as { broadcastify: { url: string; label: string } };

    expect((await ask(34.1808, -118.309)).broadcastify).toEqual({ url: "https://www.broadcastify.com/listen/ctid/201", label: "Live police, fire and EMS radio for Los Angeles County, CA (Broadcastify)" });
    expect((await ask(34.1808, -118.3092)).broadcastify.url).toBe("https://www.broadcastify.com/listen/ctid/201");
    expect((await ask(38.58, -121.53)).broadcastify.url).toBe("https://www.broadcastify.com/listen/stid/6");
    // One place lookup per rounded location, and the state page once.
    expect(requested.filter((url) => url.includes("nominatim"))).toHaveLength(2);
    expect(requested.filter((url) => url.includes("broadcastify"))).toHaveLength(1);
    stateReply = new Response("");

    const bad = await worker.fetch(new Request("https://sentinel.example/api/scanner?lat=abc&lon=1", { headers: auth }), env);
    expect(bad.status).toBe(400);
  });
});
