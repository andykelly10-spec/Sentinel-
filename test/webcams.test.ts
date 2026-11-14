import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { parseWindy, windyQuery } from "../src/webcams";
import { createEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

// Trimmed from a real Windy response; the content is invented.
const WINDY = JSON.stringify({
  total: 2,
  webcams: [
    {
      title: "Krakow: Rynek Główny", webcamId: 1639755102, status: "active", lastUpdatedOn: "2026-11-14T01:42:45.000Z",
      images: { current: { preview: "https://imgproxy.windy.com/_/preview/plain/current/1639755102/original.jpg?v=2" } },
      location: { city: "Krakow", country: "Poland", latitude: 50.0617, longitude: 19.9373 },
      urls: { detail: "https://windy.com/webcams/1639755102" },
    },
    { title: "Broken", webcamId: 2, status: "inactive", location: { latitude: 50, longitude: 19 } },
  ],
});

const auth = { Authorization: `Basic ${btoa("x:hunter2")}` };

describe("Windy webcams", () => {
  it("asks for cameras near a point or inside the visible map", () => {
    expect(windyQuery(new URLSearchParams({ lat: "50.0647", lon: "19.945", radius: "5" }))).toBe("nearby=50.0647,19.9450,5");
    expect(windyQuery(new URLSearchParams({ lat: "50", lon: "19", radius: "900" }))).toBe("nearby=50.0000,19.0000,50");
    expect(windyQuery(new URLSearchParams({ north: "40.8", east: "-73.9", south: "40.7", west: "-74.05" }))).toBe("bbox=40.8000,-73.9000,40.7000,-74.0500");
    expect(windyQuery(new URLSearchParams({ north: "40", east: "-73.9", south: "41", west: "-74" }))).toBeNull();
    expect(windyQuery(new URLSearchParams({ lat: "abc", lon: "19" }))).toBeNull();
  });

  it("keeps active webcams with their signed image and Windy page", () => {
    expect(parseWindy(WINDY)).toEqual([
      {
        id: "1639755102", name: "Krakow: Rynek Główny", lat: 50.0617, lon: 19.9373, place: "Krakow, Poland",
        image: "https://imgproxy.windy.com/_/preview/plain/current/1639755102/original.jpg?v=2",
        link: "https://windy.com/webcams/1639755102", updated: "2026-11-14T01:42:45.000Z",
      },
    ]);
  });

  it("sends the key from the server only, and says when it is missing", async () => {
    const request = () => new Request("https://sentinel.example/api/webcams?lat=50.06&lon=19.94&radius=5", { headers: auth });
    const missing = await worker.fetch(request(), createEnv());
    expect(missing.status).toBe(503);

    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(WINDY);
    });
    const response = await worker.fetch(request(), createEnv({ WINDY_API_KEY: "secret-key" }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { cameras: unknown[] }).cameras).toHaveLength(1);
    expect(seen[0]!.headers.get("x-windy-api-key")).toBe("secret-key");
    expect(seen[0]!.url).toContain("nearby=50.0600,19.9400,5");
  });
});
