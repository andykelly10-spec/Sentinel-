import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { briefHtml, briefText, type Brief } from "../src/brief";
import { insertItems, latestBrief } from "../src/db";
import { BRIEF_CRON } from "../src/schedule";
import { createEnv, NOW } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BRIEF: Brief = {
  headline: "Active shooter contained near the Washington bureau; no staff affected.",
  threatLevel: "elevated",
  overview: "One critical incident overnight in Washington DC, now over. A phishing domain imitating HBO Max is live.",
  regions: [
    { name: "Americas", items: [{ severity: "critical", title: "Logan Circle shooting", detail: "Gunman dead after shooting at a gym 0.7 miles from the CBS News Washington Bureau. Confirm staff are accounted for." }] },
    { name: "Online", items: [{ severity: "medium", title: "Lookalike domain <hbomax--tvsignin.com>", detail: "Certificate issued in September; request a takedown." }] },
  ],
  watch: ["Copycat threats in Washington DC"],
};

function stubClaude(capture: Array<any>, reply: object | null = BRIEF) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.anthropic.com") {
      capture.push(await request.json());
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: reply ? "end_turn" : "refusal",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        content: reply ? [{ type: "text", text: JSON.stringify(reply) }] : [],
      });
    }
    if (url.hostname === "api.sendgrid.com") {
      capture.push({ email: await request.json() });
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected request to ${url.hostname}`);
  });
}

const alert = (id: string, fields: object) => ({
  id: id.padEnd(32, "0"),
  source: "bing_local" as const,
  url: "https://news.example/a",
  title: "Title",
  snippet: "",
  author: "",
  publishedAt: null,
  category: "physical" as const,
  severity: "critical" as const,
  summary: "Summary",
  incident: "",
  place: "",
  lat: null,
  lon: null,
  site: "",
  distanceMi: null,
  ...fields,
});

describe("morning brief", () => {
  it("summarises the last day's alerts by incident, stores the brief and emails it", async () => {
    const env = createEnv({ SENDGRID_API_KEY: "sg", ALERT_EMAIL_FROM: "alerts@sentinel.example", ALERT_EMAIL_TO: "soc@sentinel.example" });
    await insertItems(
      env.DB,
      [
        alert("a1", { incident: "Logan Circle gym shooting", site: "CBS News Washington Bureau", distanceMi: 0.7 }),
        alert("a2", { incident: "Logan Circle gym shooting", severity: "high" }),
        alert("a3", { category: "none", severity: "low" }),
        alert("a4", { category: "cyber", severity: "medium", title: "Lookalike domain: hbomax--tvsignin.com" }),
      ],
      new Date(NOW.getTime() - 3_600_000).toISOString(),
    );
    const capture: any[] = [];
    stubClaude(capture);
    vi.useFakeTimers({ toFake: ["Date"], now: NOW.getTime() });

    const response = await worker.fetch(
      new Request("https://sentinel.example/api/brief", { method: "POST", headers: { Authorization: `Basic ${btoa("team:hunter2")}` } }),
      env,
    );
    expect(response.status).toBe(200);

    const request = capture[0];
    expect(request.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    const sent = JSON.parse(request.messages[0].content);
    expect(sent.alerts.map((a: any) => [a.incident || a.title, a.reports])).toEqual([
      ["Logan Circle gym shooting", 2],
      ["Lookalike domain: hbomax--tvsignin.com", 1],
    ]);

    const stored = await latestBrief(env.DB);
    expect(stored).toMatchObject({ createdAt: NOW.toISOString(), body: BRIEF });

    const email = capture.find((entry) => entry.email)!.email;
    expect(email.subject).toBe(`[Sentinel] Morning brief: ${BRIEF.headline}`);
    expect(email.content[0].value).toContain("- [CRITICAL] Logan Circle shooting: Gunman dead");

    const read = (await (await worker.fetch(new Request("https://sentinel.example/api/brief", { headers: { Authorization: `Basic ${btoa("team:hunter2")}` } }), env)).json()) as any;
    expect(read.brief.body.headline).toBe(BRIEF.headline);
  });

  it("reports a refusal instead of storing an empty brief", async () => {
    const env = createEnv();
    stubClaude([], null);
    const response = await worker.fetch(
      new Request("https://sentinel.example/api/brief", { method: "POST", headers: { Authorization: `Basic ${btoa("team:hunter2")}` } }),
      env,
    );
    expect(response.status).toBe(502);
    expect(await latestBrief(env.DB)).toBeNull();
  });

  it("runs on its own schedule", async () => {
    const env = createEnv();
    const capture: any[] = [];
    stubClaude(capture);
    await worker.scheduled({ cron: BRIEF_CRON, scheduledTime: NOW.getTime(), noRetry() {} } as ScheduledController, env);
    expect(capture).toHaveLength(1);
    expect(await latestBrief(env.DB)).not.toBeNull();
  });

  it("escapes model text in the email", () => {
    const html = briefHtml(BRIEF, "");
    expect(html).toContain("Lookalike domain &lt;hbomax--tvsignin.com&gt;");
    expect(html).not.toContain("<hbomax");
    expect(briefText(BRIEF, "https://sentinel.example")).toContain("Dashboard: https://sentinel.example");
  });
});
