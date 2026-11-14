import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { listAlerts } from "../src/db";
import { runOutages } from "../src/hazards";
import { decodeText, outageItems, parseIoda, PROVIDERS, type OutagePicture } from "../src/hazards/outages";
import { OUTAGE_CRON } from "../src/schedule";
import type { Site } from "../src/types";
import { createEnv, NOW } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const provider = (name: string) => PROVIDERS.find((each) => each.name === name)!;

// Samples in each service's real format. The content is invented.
const STATUSPAGE = JSON.stringify({
  page: { name: "Cloudflare Status" },
  incidents: [
    {
      id: "abc123", name: "Elevated errors on the dashboard", status: "investigating", impact: "major",
      started_at: "2026-11-12T11:00:00.000Z", shortlink: "https://stspg.io/abc",
      incident_updates: [{ body: "We are investigating <b>elevated</b> errors." }],
    },
    { id: "def456", name: "Minor delays in one region", status: "monitoring", impact: "minor", started_at: "2026-11-12T10:00:00.000Z", incident_updates: [] },
  ],
});

const AWS_EVENTS = JSON.stringify([
  {
    date: String(Date.parse("2026-11-12T10:30:00Z") / 1000), arn: "arn:aws:health:us-east-1::event/EC2/1", region_name: "N. Virginia", status: "3",
    service_name: "Amazon EC2", summary: "Increased error rates",
    event_log: [{ message: "We are investigating.", timestamp: 1 }, { message: "We have identified the cause.", timestamp: 2 }],
  },
]);

function utf16be(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    bytes[2 + i * 2] = text.charCodeAt(i) >> 8;
    bytes[3 + i * 2] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

const M365 = JSON.stringify([
  { ServiceDisplayName: "Microsoft 365 (Consumer)", ServiceWorkloadName: "M365Consumer", Title: "Users may be unable to sign in", Message: "User impact: Users may be\r\nunable to sign in.", Status: "Service degradation" },
  { ServiceDisplayName: "Outlook.com", ServiceWorkloadName: "Outlook", Title: "", Message: "", Status: "Operational" },
]);

const GOOGLE = JSON.stringify([
  { id: "g1", begin: "2026-11-12T09:00:00+00:00", end: null, external_desc: "Gmail users see delivery delays", status_impact: "SERVICE_DISRUPTION", affected_products: [{ title: "Gmail" }], uri: "incidents/g1", most_recent_update: { text: "Mitigation in progress." } },
  { id: "g0", begin: "2026-10-01T09:00:00+00:00", end: "2026-10-01T10:00:00+00:00", external_desc: "Old incident", status_impact: "SERVICE_OUTAGE" },
]);

const SLACK = JSON.stringify({ status: "active", active_incidents: [{ id: 9, title: "Messages fail to send", type: "outage", status: "active", url: "https://slack-status.com/2026-11/x", date_created: "2026-11-12T11:30:00-08:00", services: ["Messaging"] }] });

const IODA = JSON.stringify({
  data: [
    { datasource: "bgp", entity: { code: "GH", name: "Ghana" }, time: 1794600000, level: "critical" },
    { datasource: "ping-slash24", entity: { code: "GH", name: "Ghana" }, time: 1794600300, level: "critical" },
    { datasource: "bgp", entity: { code: "NE", name: "Niger" }, time: 1794600000, level: "critical" },
    { datasource: "bgp", entity: { code: "NE", name: "Niger" }, time: 1794604500, level: "normal" },
    { datasource: "gtr", entity: { code: "FI", name: "Finland" }, time: 1794600000, level: "critical" },
  ],
});

describe("status feeds", () => {
  it("reads open incidents from Statuspage sites", () => {
    expect(provider("Cloudflare").parse(STATUSPAGE)).toEqual([
      { provider: "Cloudflare", id: "abc123", title: "Elevated errors on the dashboard", status: "investigating", severity: "medium", started: "2026-11-12T11:00:00.000Z", url: "https://stspg.io/abc", detail: "We are investigating elevated errors." },
      expect.objectContaining({ id: "def456", severity: "low", url: "https://www.cloudflarestatus.com/" }),
    ]);
  });

  it("reads AWS's UTF-16 feed", () => {
    const text = decodeText(utf16be(AWS_EVENTS));
    expect(provider("AWS").parse(text)).toEqual([
      expect.objectContaining({ title: "Amazon EC2 (N. Virginia): Increased error rates", severity: "high", started: "2026-11-12T10:30:00.000Z", detail: "We have identified the cause." }),
    ]);
    expect(decodeText(new TextEncoder().encode("[]"))).toBe("[]");
  });

  it("reads Microsoft 365, Google and Slack", () => {
    expect(provider("Microsoft 365").parse(M365)).toEqual([
      expect.objectContaining({ title: "Microsoft 365 (Consumer): Users may be unable to sign in", severity: "medium", detail: "User impact: Users may be unable to sign in." }),
    ]);
    expect(provider("Google Workspace").parse(GOOGLE)).toEqual([
      expect.objectContaining({ title: "Gmail: Gmail users see delivery delays", severity: "medium", url: "https://www.google.com/appsstatus/dashboard/incidents/g1" }),
    ]);
    expect(provider("Slack").parse(SLACK)).toEqual([expect.objectContaining({ title: "Messages fail to send", severity: "high", detail: "Messaging" })]);
  });
});

describe("internet outages", () => {
  it("treats a country as out while its latest alert is critical", () => {
    expect(parseIoda(IODA)).toEqual([
      { code: "GH", country: "Ghana", since: new Date(1794600000 * 1000).toISOString(), signals: ["bgp", "ping-slash24"] },
      { code: "FI", country: "Finland", since: new Date(1794600000 * 1000).toISOString(), signals: ["gtr"] },
    ]);
  });
});

describe("outage alerts", () => {
  const accra: Site = { id: 1, name: "Accra office", address: "", city: "Accra", country: "GH", lat: 5.6, lon: -0.19, area: "", keywords: "", priority: true, approximate: false, nws_zones: "", region: "" };
  const helsinki: Site = { ...accra, id: 2, name: "Helsinki office", country: "FI", lat: 60.17, lon: 24.94 };

  it("alerts on serious outages only, and on internet outages where there is a site", async () => {
    const picture: OutagePicture = {
      updatedAt: NOW.toISOString(),
      providers: [{ name: "Cloudflare", what: "", page: "", error: null, outages: provider("Cloudflare").parse(STATUSPAGE) }],
      internet: parseIoda(IODA),
      internetError: null,
    };
    const items = await outageItems(picture, [accra, helsinki], NOW);
    expect(items.map((item) => [item.title, item.severity, item.category, item.site])).toEqual([
      ["Cloudflare outage: Elevated errors on the dashboard", "medium", "cyber", ""],
      ["Internet outage detected in Ghana", "high", "cyber", "Accra office"],
    ]);
  });

  it("runs on its own schedule and stores what it finds", async () => {
    const env = createEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.hostname === "www.cloudflarestatus.com") return new Response(STATUSPAGE);
      if (url.hostname === "slack-status.com") return new Response(SLACK);
      if (url.hostname === "api.ioda.inetintel.cc.gatech.edu") return new Response(IODA);
      if (url.hostname === "health.aws.amazon.com") return new Response(utf16be("[]"));
      if (url.hostname === "azure.status.microsoft") return new Response("<rss><channel></channel></rss>");
      if (url.hostname.includes("status") || url.hostname === "www.google.com") return new Response(url.pathname.endsWith("unresolved.json") ? '{"incidents":[]}' : "[]");
      throw new Error(`unexpected request to ${url.hostname}`);
    });
    const run = await runOutages(env, NOW);
    expect(run).toMatchObject({ kind: "outages", newItems: 2, errors: [] });
    const alerts = await listAlerts(env.DB, { category: "cyber", limit: 50 });
    expect(alerts.map((alert) => alert.title).sort()).toEqual(["Cloudflare outage: Elevated errors on the dashboard", "Slack outage: Messages fail to send"]);

    await worker.scheduled({ cron: OUTAGE_CRON, scheduledTime: NOW.getTime() + 15 * 60_000, noRetry() {} } as ScheduledController, env);
    const status = (await (await worker.fetch(new Request("https://sentinel.example/api/status", { headers: { Authorization: `Basic ${btoa("x:hunter2")}` } }), env)).json()) as { lastOutageRun: { kind: string } };
    expect(status.lastOutageRun.kind).toBe("outages");
  });
});
