// Locks in what the native iPhone app depends on (see API.md in sentinel-ios):
// HTTP Basic auth with any username, JSON bodies, and POSTs that carry no
// Origin header, as a native HTTP client sends them.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { insertItems } from "../src/db";
import type { MyLocation } from "../src/me";
import type { Alert, ClassifiedItem, Env } from "../src/types";
import { createEnv, NOW } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://sentinel.example";
const basic = (password: string, username = "iphone") => ({ Authorization: `Basic ${btoa(`${username}:${password}`)}` });
const app = basic("hunter2");
const ALERT_ID = "0123456789abcdef0123456789abcdef";

const item = (id: string, fields: Partial<ClassifiedItem> = {}): ClassifiedItem => ({
  id,
  source: "nws",
  url: "https://alerts.example/warning",
  title: "Flash flood warning for Santa Monica",
  snippet: "Heavy rain expected.",
  author: "National Weather Service",
  publishedAt: NOW.toISOString(),
  category: "hazard",
  severity: "high",
  summary: "Flash flood warning in effect until 6 pm.",
  incident: "",
  place: "Santa Monica, CA",
  lat: 34.0195,
  lon: -118.4912,
  site: "Skydance Media headquarters",
  distanceMi: 0.8,
  ...fields,
});

async function seed(env: Env): Promise<void> {
  await insertItems(env.DB, [item(ALERT_ID), item("fedcba9876543210fedcba9876543210", { category: "none", severity: "low" })], NOW.toISOString());
}

// A native client: no Origin, no cookie, just the Basic header.
function get(env: Env, path: string, headers: Record<string, string> = app) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
}

function post(env: Env, path: string, body: unknown, headers: Record<string, string> = app) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
}

const NOMINATIM = JSON.stringify({
  address: { quarter: "Downtown Santa Monica", city: "Santa Monica", state: "California", postcode: "90401", country_code: "us" },
});
const NWS_POINT = JSON.stringify({
  properties: { forecastZone: "https://api.weather.gov/zones/forecast/CAZ368", county: "https://api.weather.gov/zones/county/CAC037" },
});

function stubPlaceLookups() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.hostname === "nominatim.openstreetmap.org") return new Response(NOMINATIM);
    if (url.hostname === "api.weather.gov") return new Response(NWS_POINT);
    throw new Error(`unexpected request to ${url.hostname}`);
  });
}

describe("native iPhone client", () => {
  it("reads alerts with Basic auth and no Origin, as JSON in the documented shape", async () => {
    const env = createEnv();
    await seed(env);
    const response = await get(env, "/api/alerts?status=new");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { alerts } = (await response.json()) as { alerts: Alert[] };
    // Non-alerts (category "none") are never listed.
    expect(alerts.map((alert) => alert.id)).toEqual([ALERT_ID]);
    expect(Object.keys(alerts[0]!).sort()).toEqual(
      [
        "id", "source", "url", "title", "snippet", "author", "publishedAt", "firstSeenAt", "category", "severity",
        "summary", "status", "incident", "place", "lat", "lon", "site", "distanceMi", "expiresAt",
      ].sort(),
    );
    expect(alerts[0]).toMatchObject({ status: "new", severity: "high", category: "hazard", lat: 34.0195, distanceMi: 0.8, expiresAt: null });

    // Unknown filter values are ignored rather than refused.
    expect((await get(env, "/api/alerts?severity=extreme")).status).toBe(200);
    const filtered = (await (await get(env, "/api/alerts?severity=low")).json()) as { alerts: Alert[] };
    expect(filtered.alerts).toEqual([]);
  });

  it("accepts any username, and refuses a wrong or missing password with 401 Sign in required", async () => {
    const env = createEnv();
    expect((await get(env, "/api/status", basic("hunter2", ""))).status).toBe(200);
    expect((await get(env, "/api/status", basic("hunter2", "anyone"))).status).toBe(200);

    for (const headers of [basic("wrong"), {}, { Authorization: "Bearer hunter2" }]) {
      const response = await get(env, "/api/alerts", headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Sign in required" });
      expect(response.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("returns the status header the app signs in with", async () => {
    const env = createEnv();
    await seed(env);
    const status = (await (await get(env, "/api/status")).json()) as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual(["activity", "email", "lastHazardRun", "lastOutageRun", "lastRun", "me", "open", "sites", "sms"]);
    expect(status).toMatchObject({ lastRun: null, me: null, open: { high: 1 }, email: false, sms: false });
    expect((status.sites as unknown[]).length).toBeGreaterThan(0);
  });

  it("acknowledges and dismisses an alert by POST with no Origin header", async () => {
    const env = createEnv();
    await seed(env);
    const acknowledged = await post(env, `/api/alerts/${ALERT_ID}/status`, { status: "acknowledged" });
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toEqual({ ok: true });
    const { alerts } = (await (await get(env, "/api/alerts?status=acknowledged")).json()) as { alerts: Alert[] };
    expect(alerts.map((alert) => alert.id)).toEqual([ALERT_ID]);

    expect((await post(env, `/api/alerts/${ALERT_ID}/status`, { status: "dismissed" })).status).toBe(200);

    const missing = await post(env, "/api/alerts/ffffffffffffffffffffffffffffffff/status", { status: "acknowledged" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Alert not found" });

    const invalid = await post(env, `/api/alerts/${ALERT_ID}/status`, { status: "closed" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "status must be one of: new, acknowledged, dismissed, expired" });

    // An id that is not 32 lowercase hex characters does not match the route at all.
    const malformed = await post(env, `/api/alerts/${ALERT_ID.toUpperCase()}/status`, { status: "acknowledged" });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: "Not found" });
  });

  it("still refuses a POST from a foreign Origin, but accepts the exact origin", async () => {
    const env = createEnv();
    await seed(env);
    const foreign = await post(env, `/api/alerts/${ALERT_ID}/status`, { status: "acknowledged" }, { ...app, Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "Cross-origin request refused" });
    // "null", as some clients send, is foreign too.
    expect((await post(env, "/api/me/off", {}, { ...app, Origin: "null" })).status).toBe(403);

    const same = await post(env, `/api/alerts/${ALERT_ID}/status`, { status: "acknowledged" }, { ...app, Origin: ORIGIN });
    expect(same.status).toBe(200);
  });

  it("takes My location by POST /api/me with no Origin, and stops with POST /api/me/off", async () => {
    const env = createEnv();
    stubPlaceLookups();
    const response = await post(env, "/api/me", { lat: 34.019512, lon: -118.491234, accuracyM: 12.6, radiusMi: 2 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: MyLocation; checking: boolean };
    expect(body.checking).toBe(true);
    expect(body.location).toMatchObject({ lat: 34.02, lon: -118.491, accuracyM: 13, radiusMi: 2, city: "Santa Monica", postcode: "90401" });

    // A radius outside 0.5, 1, 2, 5 or 10 falls back to 1 mile; missing coordinates are refused.
    const odd = (await (await post(env, "/api/me", { lat: 34.0195, lon: -118.4912, radiusMi: 3 })).json()) as { location: MyLocation };
    expect(odd.location.radiusMi).toBe(1);
    const bad = await post(env, "/api/me", { lat: "34.0195", lon: -118.4912 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "lat and lon are required" });

    const status = (await (await get(env, "/api/status")).json()) as { me: MyLocation | null };
    expect(status.me?.city).toBe("Santa Monica");

    const off = await post(env, "/api/me/off", {});
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true });
    expect(((await (await get(env, "/api/status")).json()) as { me: unknown }).me).toBeNull();
  });
});
