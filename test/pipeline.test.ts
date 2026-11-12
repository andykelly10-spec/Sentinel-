import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { listAlerts } from "../src/db";
import { runPipeline } from "../src/pipeline";
import type { Env } from "../src/types";
import { createEnv, GDELT_JSON, GOOGLE_NEWS_RSS, HN_JSON, NOW } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

interface Outbound {
  claude: Array<{ headers: Headers; body: any }>;
  emails: any[];
  texts: URLSearchParams[];
}

// Stands in for every external service. The fake classifier labels items by
// keyword so the test controls which items become alerts.
function stubNetwork(options: { claude?: (body: any) => Response; sendgrid?: () => Response } = {}): Outbound {
  const outbound: Outbound = { claude: [], emails: [], texts: [] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname === "news.google.com") return new Response(GOOGLE_NEWS_RSS);
    if (hostname === "api.gdeltproject.org") return new Response(GDELT_JSON);
    if (hostname === "www.reddit.com") return new Response("blocked", { status: 403 });
    if (hostname === "hn.algolia.com") return new Response(HN_JSON);
    if (hostname === "api.sendgrid.com") {
      outbound.emails.push(await request.json());
      return options.sendgrid?.() ?? new Response(null, { status: 202 });
    }
    if (hostname === "api.twilio.com") {
      outbound.texts.push(new URLSearchParams(await request.text()));
      return new Response("{}", { status: 201 });
    }
    if (hostname === "api.anthropic.com") {
      const body = await request.json();
      outbound.claude.push({ headers: request.headers, body });
      return options.claude?.(body) ?? claudeReply(body, keywordClassifier);
    }
    throw new Error(`unexpected request to ${hostname}`);
  });
  return outbound;
}

type Verdict = { category: string; severity: string; summary: string };

function keywordClassifier(item: { title: string }): Verdict {
  if (item.title.includes("Protesters")) {
    return { category: "physical", severity: "critical", summary: "A demonstration is planned outside the premiere." };
  }
  if (item.title.includes("breach")) {
    return { category: "cyber", severity: "high", summary: "A group claims to have breached internal servers." };
  }
  if (item.title.includes("Comment on")) {
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
  const items: Array<{ index: number; title: string }> = JSON.parse(body.messages[0].content);
  const results = items.flatMap((item) => {
    const verdict = classify(item);
    return verdict ? [{ index: item.index, ...verdict }] : [];
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

    expect(run).toMatchObject({ fetched: 5, newItems: 5, alerts: 3, errors: [] });
    expect(run.sources.find((s) => s.source === "reddit")).toEqual({ source: "reddit", count: 0, error: "HTTP 403" });

    const alerts = await listAlerts(env.DB, { limit: 50 });
    expect(alerts.map((a) => [a.category, a.severity]).sort()).toEqual([
      ["cyber", "high"],
      ["cyber", "low"],
      ["physical", "critical"],
    ]);

    // One request carried all five items, with the documented request shape.
    expect(outbound.claude).toHaveLength(1);
    const { headers, body } = outbound.claude[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(body.thinking).toBeUndefined();

    // The email digest covers medium and above, most severe first.
    expect(outbound.emails).toHaveLength(1);
    const email = outbound.emails[0];
    expect(email.subject).toBe("[Sentinel] 2 new alerts (1 critical)");
    expect(email.personalizations).toEqual([
      { to: [{ email: "soc@sentinel.example" }] },
      { to: [{ email: "duty@sentinel.example" }] },
    ]);
    expect(email.content[0].value).toMatch(/^\[CRITICAL\] physical: Protesters/);
    expect(email.content[0].value).not.toContain("phishing wave");

    // Only the critical alert is texted: high-severity cyber is email-only.
    expect(outbound.texts).toHaveLength(1);
    expect(outbound.texts[0]!.get("To")).toBe("+15551111111");
    expect(outbound.texts[0]!.get("Body")).toBe(
      "Sentinel CRITICAL physical: A demonstration is planned outside the premiere. https://sentinel.example",
    );

    // A second run sees nothing new and sends nothing again.
    const second = await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));
    expect(second).toMatchObject({ fetched: 5, newItems: 0, alerts: 0 });
    expect(outbound.claude).toHaveLength(1);
    expect(outbound.emails).toHaveLength(1);
    expect(outbound.texts).toHaveLength(1);
  });

  it("flags items the classifier skipped or refused for manual review", async () => {
    stubNetwork({ claude: (body) => claudeReply(body, (item) => (item.title.includes("breach") ? null : keywordClassifier(item))) });
    const env = createEnv();
    const run = await runPipeline(env, NOW);
    expect(run.alerts).toBe(3);
    const review = await listAlerts(env.DB, { category: "unclassified", limit: 50 });
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ severity: "medium", title: expect.stringContaining("breach") });

    stubNetwork({ claude: () => message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "" } }) });
    const refusedEnv = createEnv();
    const refused = await runPipeline(refusedEnv, NOW);
    expect(refused.alerts).toBe(5);
    expect(await listAlerts(refusedEnv.DB, { category: "unclassified", limit: 50 })).toHaveLength(5);
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
    expect(retried).toMatchObject({ newItems: 5, alerts: 3, errors: [] });
  });

  it("retries a failed email on the next run", async () => {
    const env = createEnv(withEmail);
    stubNetwork({ sendgrid: () => new Response("sender not verified", { status: 403 }) });
    const first = await runPipeline(env, NOW);
    expect(first.errors).toEqual(["Email: SendGrid HTTP 403: sender not verified"]);

    const outbound = stubNetwork();
    await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));
    expect(outbound.emails).toHaveLength(1);
    expect(outbound.emails[0].subject).toBe("[Sentinel] 2 new alerts (1 critical)");
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
    stubNetwork();
    const env = createEnv();
    await runPipeline(env, NOW);

    const all = (await (await call(env, "/api/alerts")).json()) as { alerts: any[] };
    expect(all.alerts).toHaveLength(3);
    const cyber = (await (await call(env, "/api/alerts?category=cyber&severity=high")).json()) as { alerts: any[] };
    expect(cyber.alerts).toHaveLength(1);

    const id = cyber.alerts[0].id;
    const post = (path: string, body: object, headers: Record<string, string> = {}) =>
      call(env, path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

    expect((await post(`/api/alerts/${id}/status`, { status: "bogus" })).status).toBe(400);
    expect((await post(`/api/alerts/${"0".repeat(32)}/status`, { status: "dismissed" })).status).toBe(404);
    expect((await post(`/api/alerts/${id}/status`, { status: "dismissed" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`/api/alerts/${id}/status`, { status: "dismissed" })).status).toBe(200);

    const open = (await (await call(env, "/api/alerts?status=new")).json()) as { alerts: any[] };
    expect(open.alerts).toHaveLength(2);

    const status = (await (await call(env, "/api/status")).json()) as any;
    expect(status.open).toEqual({ critical: 1, low: 1 });
    expect(status.lastRun.newItems).toBe(5);
    expect(status).toMatchObject({ email: false, sms: false });
  });
});
