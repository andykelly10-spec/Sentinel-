import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { listAlerts } from "../src/db";
import { runPipeline } from "../src/pipeline";
import type { Env } from "../src/types";
import { createEnv, NOW, sourceResponse } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface Outbound {
  claude: Array<{ headers: Headers; body: any }>;
  emails: any[];
  texts: URLSearchParams[];
}

// Stands in for every external service. The fake classifier labels items by
// keyword so the test controls which items become alerts.
function stubNetwork(
  options: { claude?: (body: any) => Response; sendgrid?: () => Response; bingLocal?: string } = {},
): Outbound {
  const outbound: Outbound = { claude: [], emails: [], texts: [] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const source = sourceResponse(url, options);
    if (source) return source;
    if (url.hostname === "api.sendgrid.com") {
      outbound.emails.push(await request.json());
      return options.sendgrid?.() ?? new Response(null, { status: 202 });
    }
    if (url.hostname === "api.twilio.com") {
      outbound.texts.push(new URLSearchParams(await request.text()));
      return new Response("{}", { status: 201 });
    }
    if (url.hostname === "api.anthropic.com") {
      const body = await request.json();
      outbound.claude.push({ headers: request.headers, body });
      return options.claude?.(body) ?? claudeReply(body, keywordClassifier);
    }
    throw new Error(`unexpected request to ${url.hostname}`);
  });
  return outbound;
}

type Verdict = { category: string; severity: string; summary: string; incident?: string; place?: string; lat?: number; lon?: number };

function keywordClassifier(item: { title: string }): Verdict {
  if (item.title.includes("Protesters")) {
    return { category: "physical", severity: "critical", summary: "A demonstration is planned outside the premiere." };
  }
  if (item.title.includes("Farragut")) {
    return {
      category: "physical",
      severity: "critical",
      summary: "Shots fired near Farragut Square; the suspect is at large.",
      incident: "Farragut Square shooting",
      place: "Farragut Square, Washington DC",
      lat: 38.902,
      lon: -77.039,
    };
  }
  if (item.title.includes("breach")) {
    return { category: "cyber", severity: "high", summary: "A group claims to have breached internal servers." };
  }
  if (item.title.includes("Ask HN")) {
    return { category: "cyber", severity: "low", summary: "A commenter mentions a past phishing wave." };
  }
  return { category: "none", severity: "low", summary: "" };
}

function message(fields: object): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [],
    ...fields,
  });
}

function claudeReply(body: any, classify: (item: { title: string }) => Verdict | null): Response {
  const { items } = JSON.parse(body.messages[0].content) as { items: Array<{ index: number; title: string }> };
  const results = items.flatMap((item) => {
    const verdict = classify(item);
    return verdict ? [{ index: item.index, incident: "", place: "", lat: null, lon: null, ...verdict }] : [];
  });
  return message({ content: [{ type: "text", text: JSON.stringify({ results }) }] });
}

const withEmail: Partial<Env> = {
  SENDGRID_API_KEY: "sg-test",
  ALERT_EMAIL_FROM: "alerts@sentinel.example",
  ALERT_EMAIL_TO: "soc@sentinel.example, duty@sentinel.example",
};
const withSms: Partial<Env> = {
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM_NUMBER: "+15550000000",
  ALERT_SMS_TO: "+15551111111",
};

describe("runPipeline", () => {
  it("classifies new items, stores them, and notifies once", async () => {
    const outbound = stubNetwork();
    const env = createEnv({ ...withEmail, ...withSms });

    const run = await runPipeline(env, NOW);

    expect(run).toMatchObject({ fetched: 11, newItems: 11, alerts: 5, errors: [] });
    expect(run.sources.every((source) => source.error === null)).toBe(true);

    const alerts = await listAlerts(env.DB, { limit: 50 });
    expect(alerts.map((a) => [a.category, a.severity]).sort()).toEqual([
      ["cyber", "high"],
      ["cyber", "low"],
      ["physical", "critical"],
      ["physical", "critical"],
      ["physical", "critical"],
    ]);

    // Both reports of the shooting are tied to one incident and to the nearest site.
    const shooting = alerts.filter((a) => a.incident === "Farragut Square shooting");
    expect(shooting.map((a) => a.source).sort()).toEqual(["bing_local", "bluesky_urgent"]);
    expect(shooting[0]).toMatchObject({
      place: "Farragut Square, Washington DC",
      lat: 38.902,
      lon: -77.039,
      site: "CBS News Washington Bureau",
      distanceMi: 0.4,
    });
    expect(alerts.find((a) => a.title.startsWith("Protesters"))).toMatchObject({ site: "", distanceMi: null, lat: null });

    // One request carried all eleven items, with the documented request shape.
    expect(outbound.claude).toHaveLength(1);
    const { headers, body } = outbound.claude[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(body.thinking).toBeUndefined();
    // The site list from the database is part of the cached instructions.
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0].text).toContain("- CBS News Washington Bureau | Washington, US | 38.9056, -77.0457");

    // The email digest covers medium and above, with one entry per incident.
    expect(outbound.emails).toHaveLength(1);
    const email = outbound.emails[0];
    expect(email.subject).toBe("[Sentinel] 3 new alerts (2 critical)");
    expect(email.personalizations).toEqual([
      { to: [{ email: "soc@sentinel.example" }] },
      { to: [{ email: "duty@sentinel.example" }] },
    ]);
    expect(email.content[0].value).toContain("[CRITICAL] physical: Farragut Square shooting (2 reports)");
    expect(email.content[0].value).toContain("about 0.4 mi from CBS News Washington Bureau");
    expect(email.content[0].value).toContain("[CRITICAL] physical: Protesters");
    expect(email.content[0].value).not.toContain("phishing wave");

    // Only critical alerts are texted, once per incident: high-severity cyber is email-only.
    expect(outbound.texts.map((text) => text.get("Body")).sort()).toEqual([
      "Sentinel CRITICAL physical: A demonstration is planned outside the premiere. https://sentinel.example",
      "Sentinel CRITICAL physical: Shots fired near Farragut Square; the suspect is at large. (about 0.4 mi from CBS News Washington Bureau) https://sentinel.example",
    ]);
    expect(outbound.texts[0]!.get("To")).toBe("+15551111111");

    // A second run sees nothing new and sends nothing again.
    const second = await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));
    expect(second).toMatchObject({ fetched: 11, newItems: 0, alerts: 0 });
    expect(outbound.claude).toHaveLength(1);
    expect(outbound.emails).toHaveLength(1);
    expect(outbound.texts).toHaveLength(2);
  });

  it("recognises a later report of a known incident and does not announce it again", async () => {
    const env = createEnv({ ...withEmail, ...withSms });
    stubNetwork();
    await runPipeline(env, NOW);

    const followUp = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<item><title>Police give update on Farragut Square gunman search</title><link>https://local.example/update</link><description>Search continues.</description><pubDate>Thu, 12 Nov 2026 12:10:00 GMT</pubDate><News:Source>Local Example</News:Source></item>
</channel></rss>`;
    const outbound = stubNetwork({ bingLocal: followUp });
    const run = await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));

    expect(run).toMatchObject({ newItems: 1, alerts: 1 });
    expect(JSON.parse(outbound.claude[0]!.body.messages[0].content).incident_names_in_use).toEqual(["Farragut Square shooting"]);
    expect(await listAlerts(env.DB, { limit: 50 })).toHaveLength(6);
    expect(outbound.emails).toHaveLength(0);
    expect(outbound.texts).toHaveLength(0);
  });

  it("flags items the classifier skipped or refused for manual review", async () => {
    stubNetwork({ claude: (body) => claudeReply(body, (item) => (item.title.includes("breach") ? null : keywordClassifier(item))) });
    const env = createEnv();
    const run = await runPipeline(env, NOW);
    expect(run.alerts).toBe(5);
    const review = await listAlerts(env.DB, { category: "unclassified", limit: 50 });
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ severity: "medium", title: expect.stringContaining("breach") });

    stubNetwork({ claude: () => message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "" } }) });
    const refusedEnv = createEnv();
    const refused = await runPipeline(refusedEnv, NOW);
    expect(refused.alerts).toBe(11);
    expect(await listAlerts(refusedEnv.DB, { category: "unclassified", limit: 50 })).toHaveLength(11);
  });

  it("stores nothing when the classifier is unavailable, so the next run retries", async () => {
    stubNetwork({
      claude: () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }),
    });
    const env = createEnv();
    const failed = await runPipeline(env, NOW);
    expect(failed).toMatchObject({ newItems: 0, alerts: 0, errors: ["Classifier: ANTHROPIC_API_KEY is missing or invalid"] });

    stubNetwork();
    const retried = await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));
    expect(retried).toMatchObject({ newItems: 11, alerts: 5, errors: [] });
  });

  it("retries a failed email on the next run", async () => {
    const env = createEnv(withEmail);
    stubNetwork({ sendgrid: () => new Response("sender not verified", { status: 403 }) });
    const first = await runPipeline(env, NOW);
    expect(first.errors).toEqual(["Email: SendGrid HTTP 403: sender not verified"]);

    const outbound = stubNetwork();
    await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));
    expect(outbound.emails).toHaveLength(1);
    expect(outbound.emails[0].subject).toBe("[Sentinel] 3 new alerts (2 critical)");
  });

  it("omits the fallback parameter for models that do not accept it", async () => {
    const outbound = stubNetwork();
    await runPipeline(createEnv({ CLASSIFIER_MODEL: "claude-haiku-5-5" }), NOW);
    expect(outbound.claude[0]!.body.model).toBe("claude-haiku-5-5");
    expect(outbound.claude[0]!.body.fallbacks).toBeUndefined();
    expect(outbound.claude[0]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });
});

describe("dashboard API", () => {
  const auth = { Authorization: `Basic ${btoa("team:hunter2")}` };
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://sentinel.example${path}`, { ...init, headers: { ...auth, ...init.headers } }), env);

  it("requires the dashboard password", async () => {
    const env = createEnv();
    const anonymous = await worker.fetch(new Request("https://sentinel.example/api/alerts"), env);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain("Basic");

    const wrong = await worker.fetch(
      new Request("https://sentinel.example/", { headers: { Authorization: `Basic ${btoa("team:nope")}` } }),
      env,
    );
    expect(wrong.status).toBe(401);

    expect((await call(env, "/")).status).toBe(200);
    expect((await worker.fetch(new Request("https://sentinel.example/"), createEnv({ DASHBOARD_PASSWORD: undefined }))).status).toBe(503);
  });

  it("lists, filters and updates alerts", async () => {
    // The status endpoint reports the last 24 hours, measured from the clock.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW.getTime() + 60_000 });
    stubNetwork();
    const env = createEnv();
    await runPipeline(env, NOW);

    const all = (await (await call(env, "/api/alerts")).json()) as { alerts: any[] };
    expect(all.alerts).toHaveLength(5);
    const cyber = (await (await call(env, "/api/alerts?category=cyber&severity=high")).json()) as { alerts: any[] };
    expect(cyber.alerts).toHaveLength(1);

    const id = cyber.alerts[0].id;
    const post = (path: string, body: object, headers: Record<string, string> = {}) =>
      call(env, path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

    expect((await post(`/api/alerts/${id}/status`, { status: "bogus" })).status).toBe(400);
    expect((await post(`/api/alerts/${"0".repeat(32)}/status`, { status: "dismissed" })).status).toBe(404);
    expect((await post(`/api/alerts/${id}/status`, { status: "dismissed" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`/api/alerts/${id}/status`, { status: "dismissed" })).status).toBe(200);

    // Acknowledging an incident applies to every report of it.
    expect((await post("/api/incidents/status", { incident: "No such incident", status: "acknowledged" })).status).toBe(404);
    expect((await post("/api/incidents/status", { incident: "Farragut Square shooting", status: "acknowledged" })).status).toBe(200);

    const open = (await (await call(env, "/api/alerts?status=new")).json()) as { alerts: any[] };
    expect(open.alerts).toHaveLength(2);

    const status = (await (await call(env, "/api/status")).json()) as any;
    expect(status.open).toEqual({ critical: 1, low: 1 });
    expect(status.lastRun.newItems).toBe(11);
    expect(status).toMatchObject({ email: false, sms: false });
    expect(status.sites).toHaveLength(5);
    expect(status.sites[0]).toMatchObject({ name: "CBS Broadcast Center", city: "New York", lat: 40.7689, lon: -73.9908, priority: true });
    expect(status.activity).toEqual([{ hour: "2026-11-12T12", alerts: 5, scanned: 11 }]);
  });

  it("imports a site list, estimating coordinates that are missing", async () => {
    const outbound = stubNetwork({
      claude: () => message({ content: [{ type: "text", text: JSON.stringify({ results: [{ index: 0, lat: 34.1561, lon: -118.3353 }, { index: 1, lat: null, lon: null }] }) }] }),
    });
    const env = createEnv();
    const csv = [
      "Site Name,Address,City,Country,Latitude,Longitude,Priority",
      '"Techwood Campus","1050 Techwood Dr NW",Atlanta,US,33.7838,-84.3920,yes',
      '"Burbank Lot","4000 Warner Blvd",Burbank,US,,,',
      "Mystery Office,,Nowhereville,,,,",
      ",,London,UK,,,",
    ].join("\r\n");
    const post = (body: object) =>
      call(env, "/api/sites/import", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

    expect((await post({ csv: "city\nLondon" })).status).toBe(400);

    const response = await post({ csv });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      imported: 2,
      estimated: 1,
      skipped: ["Row 5: no name", "Mystery Office: could not work out where this is"],
    });
    // Only the two rows without coordinates were sent for estimation.
    expect(JSON.parse(outbound.claude[0]!.body.messages[0].content).map((row: any) => row.name)).toEqual(["Burbank Lot", "Mystery Office"]);

    const status = (await (await call(env, "/api/status")).json()) as any;
    expect(status.sites.map((site: any) => [site.name, site.approximate, site.priority])).toEqual([
      ["Burbank Lot", true, false],
      ["Techwood Campus", false, true],
    ]);
  });

  it("relays only the listed live feeds", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      requested.push(input);
      return input.includes("usgs") ? new Response('{"features":[]}') : new Response("down", { status: 503 });
    });
    const env = createEnv();

    const quakes = await call(env, "/api/feeds/quakes");
    expect(quakes.status).toBe(200);
    expect(quakes.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(await quakes.json()).toEqual({ features: [] });

    expect((await call(env, "/api/feeds/aircraft?lat=38.9056&lon=-77.0457")).status).toBe(502);
    expect(requested[1]).toBe("https://api.adsb.lol/v2/point/38.9056/-77.0457/40");

    expect((await call(env, "/api/feeds/aircraft?lat=abc&lon=1")).status).toBe(400);
    expect((await call(env, "/api/feeds/aircraft?lat=1/../../x&lon=1")).status).toBe(400);
    expect((await call(env, "/api/feeds/anything-else")).status).toBe(404);
    expect(requested).toHaveLength(2);
    expect((await worker.fetch(new Request("https://sentinel.example/api/feeds/quakes"), env)).status).toBe(401);
  });
});
