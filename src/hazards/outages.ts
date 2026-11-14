// Service outages: the official status feeds of the cloud, network and
// workplace services most companies depend on, plus country-wide internet
// outages detected by IODA (Georgia Tech's Internet Outage Detection and
// Analysis project). An outage can look like an attack, and attacks on a
// provider often show up first as an outage.

import { getSetting, setSetting } from "../db";
import { stripHtml, truncate } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { rssItems, tagText } from "../sources/rss";
import { hazardItem, HOUR_MS } from "./common";

export interface Outage {
  provider: string;
  id: string;
  title: string;
  status: string;
  severity: Severity;
  started: string | null;
  url: string;
  detail: string;
}

export interface Provider {
  name: string;
  // What the provider is, for people who do not know the name.
  what: string;
  url: string;
  page: string;
  parse: (body: string) => Outage[];
  // AWS publishes its feed in UTF-16.
  bytes?: boolean;
}

// Incidents open longer than this are long-running problems, not news.
const STALE_MS = 3 * 24 * HOUR_MS;

const STATUSPAGE_IMPACT: Record<string, Severity> = { none: "low", minor: "low", major: "medium", critical: "high" };

function statuspage(name: string, what: string, host: string): Provider {
  return {
    name,
    what,
    url: `https://${host}/api/v2/incidents/unresolved.json`,
    page: `https://${host}/`,
    parse: (body) =>
      ((JSON.parse(body) as { incidents?: Array<Record<string, unknown>> }).incidents ?? []).map((incident) => {
        const updates = (incident.incident_updates as Array<{ body?: string }> | undefined) ?? [];
        return {
          provider: name,
          id: String(incident.id),
          title: String(incident.name ?? "Incident"),
          status: String(incident.status ?? ""),
          severity: STATUSPAGE_IMPACT[String(incident.impact)] ?? "low",
          started: (incident.started_at ?? incident.created_at ?? null) as string | null,
          url: typeof incident.shortlink === "string" ? incident.shortlink : `https://${host}/`,
          detail: truncate(stripHtml(updates[0]?.body ?? ""), 500),
        };
      }),
  };
}

// Google Cloud and Google Workspace share one format.
function googleStatus(name: string, what: string, url: string, base: string): Provider {
  const impact: Record<string, Severity> = { SERVICE_OUTAGE: "high", SERVICE_DISRUPTION: "medium", SERVICE_INFORMATION: "low" };
  return {
    name,
    what,
    url,
    page: base,
    parse: (body) =>
      (JSON.parse(body) as Array<Record<string, unknown>>)
        .filter((incident) => !incident.end)
        .map((incident) => {
          const products = ((incident.affected_products as Array<{ title?: string }> | undefined) ?? []).map((product) => product.title).filter(Boolean);
          const latest = incident.most_recent_update as { text?: string } | undefined;
          return {
            provider: name,
            id: String(incident.id),
            title: truncate(`${products.slice(0, 3).join(", ") || String(incident.service_name ?? "")}: ${String(incident.external_desc ?? "")}`.replace(/^: /, ""), 200),
            status: String(incident.status_impact ?? "").replace(/^SERVICE_/, "").toLowerCase(),
            severity: impact[String(incident.status_impact)] ?? (incident.severity === "high" ? "high" : incident.severity === "medium" ? "medium" : "low"),
            started: (incident.begin ?? null) as string | null,
            url: typeof incident.uri === "string" ? new URL(incident.uri, base).href : base,
            detail: truncate(stripHtml(latest?.text ?? ""), 500),
          };
        }),
  };
}

const AWS_STATUS: Record<string, Severity> = { "1": "low", "2": "medium", "3": "high" };
const AWS_STATUS_NAME: Record<string, string> = { "1": "informational", "2": "degraded", "3": "disrupted" };
const M365_STATUS: Array<[RegExp, Severity]> = [
  [/interruption|outage|unavailable/i, "high"],
  [/degradation|restoring|recovery|investigating/i, "medium"],
];
const SLACK_TYPE: Record<string, Severity> = { outage: "high", incident: "medium", notice: "low" };

export const PROVIDERS: Provider[] = [
  {
    name: "AWS",
    what: "Amazon Web Services cloud",
    url: "https://health.aws.amazon.com/public/currentevents",
    page: "https://health.aws.amazon.com/health/status",
    bytes: true,
    parse: (body) =>
      (JSON.parse(body) as Array<Record<string, unknown>>).map((event) => {
        const log = (event.event_log as Array<{ message?: string; timestamp?: number }> | undefined) ?? [];
        const latest = [...log].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
        return {
          provider: "AWS",
          id: String(event.arn ?? event.service),
          title: `${String(event.service_name ?? "AWS")} (${String(event.region_name ?? "")}): ${String(event.summary ?? "")}`.replace(" ()", ""),
          status: AWS_STATUS_NAME[String(event.status)] ?? "",
          severity: AWS_STATUS[String(event.status)] ?? "low",
          started: Number(event.date) ? new Date(Number(event.date) * 1000).toISOString() : null,
          url: "https://health.aws.amazon.com/health/status",
          detail: truncate(latest?.message ?? "", 500),
        };
      }),
  },
  {
    name: "Microsoft Azure",
    what: "Microsoft's cloud",
    url: "https://azure.status.microsoft/en-us/status/feed/",
    page: "https://azure.status.microsoft/en-us/status",
    // Azure lists only widespread problems here.
    parse: (body) =>
      rssItems(body).map((item) => ({
        provider: "Microsoft Azure",
        id: tagText(item, "guid") || tagText(item, "link") || tagText(item, "title"),
        title: tagText(item, "title"),
        status: "active",
        severity: "medium" as Severity,
        started: tagText(item, "pubDate") ? new Date(tagText(item, "pubDate")).toISOString() : null,
        url: tagText(item, "link") || "https://azure.status.microsoft/en-us/status",
        detail: truncate(stripHtml(tagText(item, "description")), 500),
      })),
  },
  {
    name: "Microsoft 365",
    what: "Outlook, Teams, OneDrive and Office",
    url: "https://status.cloud.microsoft/api/posts/m365Consumer",
    page: "https://status.cloud.microsoft/",
    parse: (body) =>
      (JSON.parse(body) as Array<Record<string, string>>)
        .filter((post) => post.Status && post.Status !== "Operational" && post.Title)
        .map((post) => ({
          provider: "Microsoft 365",
          id: `${post.ServiceWorkloadName}:${post.Title}`,
          title: `${post.ServiceDisplayName}: ${post.Title}`,
          status: post.Status!,
          severity: M365_STATUS.find(([pattern]) => pattern.test(post.Status!))?.[1] ?? "low",
          started: null,
          url: "https://status.cloud.microsoft/",
          detail: truncate((post.Message ?? "").replace(/\s+/g, " "), 500),
        })),
  },
  googleStatus("Google Cloud", "Google's cloud", "https://status.cloud.google.com/incidents.json", "https://status.cloud.google.com/"),
  googleStatus("Google Workspace", "Gmail, Drive, Meet and Docs", "https://www.google.com/appsstatus/dashboard/incidents.json", "https://www.google.com/appsstatus/dashboard/"),
  {
    name: "Salesforce",
    what: "customer and marketing systems",
    url: "https://api.status.salesforce.com/v1/incidents/active",
    page: "https://status.salesforce.com/",
    parse: (body) =>
      (JSON.parse(body) as Array<Record<string, unknown>>).map((incident) => {
        const impacts = (incident.IncidentImpacts as Array<{ severity?: string; startTime?: string }> | undefined) ?? [];
        const events = (incident.IncidentEvents as Array<{ message?: string }> | undefined) ?? [];
        const worst = impacts.some((impact) => impact.severity === "major") ? "major" : "minor";
        const severity: Severity = incident.isCore && worst === "major" ? "high" : worst === "major" || incident.affectsAll ? "medium" : "low";
        return {
          provider: "Salesforce",
          id: String(incident.id),
          title: `${String(incident.type ?? "Incident")} on ${((incident.serviceKeys as string[] | undefined) ?? []).join(", ") || "Salesforce"} (${((incident.instanceKeys as string[] | undefined) ?? []).length} instances)`,
          status: String(incident.status ?? ""),
          severity,
          started: impacts[0]?.startTime ?? (incident.createdAt as string | undefined) ?? null,
          url: typeof incident.additionalInformation === "string" && incident.additionalInformation.startsWith("https://") ? incident.additionalInformation : "https://status.salesforce.com/",
          detail: truncate(events[0]?.message ?? "", 500),
        };
      }),
  },
  {
    name: "Slack",
    what: "workplace messaging",
    url: "https://slack-status.com/api/v2.0.0/current",
    page: "https://slack-status.com/",
    parse: (body) =>
      ((JSON.parse(body) as { active_incidents?: Array<Record<string, unknown>> }).active_incidents ?? []).map((incident) => ({
        provider: "Slack",
        id: String(incident.id),
        title: String(incident.title ?? "Incident"),
        status: String(incident.status ?? ""),
        severity: SLACK_TYPE[String(incident.type)] ?? "medium",
        started: (incident.date_created ?? null) as string | null,
        url: typeof incident.url === "string" ? incident.url : "https://slack-status.com/",
        detail: ((incident.services as string[] | undefined) ?? []).join(", "),
      })),
  },
  statuspage("Cloudflare", "web security and delivery network", "www.cloudflarestatus.com"),
  statuspage("Akamai", "content delivery network used for streaming", "www.akamaistatus.com"),
  statuspage("Zoom", "video meetings", "status.zoom.us"),
  statuspage("GitHub", "code hosting", "www.githubstatus.com"),
  statuspage("Atlassian", "Jira and Confluence", "status.atlassian.com"),
  statuspage("Twilio", "text messaging and SendGrid email", "status.twilio.com"),
];

// AWS sends UTF-16 with a byte-order mark; everything else is UTF-8.
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1]!;
      swapped[i - 1] = bytes[i]!;
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  return new TextDecoder().decode(bytes);
}

async function fetchBytes(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "sentinel-monitor/0.1 (brand security monitoring)", Accept: "*/*" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return decodeText(new Uint8Array(await response.arrayBuffer()));
}

// ---------- internet outages by country ----------

export interface InternetOutage {
  code: string;
  country: string;
  since: string;
  // The ways IODA saw it: routing (bgp), active probing (ping-slash24), telescope traffic (merit-nt).
  signals: string[];
}

export const IODA_URL = (now: Date) => {
  const until = Math.floor(now.getTime() / 1000);
  return `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=${until - 86_400}&until=${until}&entityType=country&limit=500`;
};

// A country is out while the latest alert from any of IODA's signals is critical.
export function parseIoda(body: string): InternetOutage[] {
  const alerts = (JSON.parse(body) as { data?: Array<Record<string, unknown>> }).data ?? [];
  const latest = new Map<string, { level: string; time: number; name: string; code: string; signal: string }>();
  for (const alert of alerts) {
    const entity = alert.entity as { code?: string; name?: string } | undefined;
    const code = entity?.code ?? "";
    const signal = String(alert.datasource ?? "");
    const time = Number(alert.time);
    const key = `${code}:${signal}`;
    if (!code || !Number.isFinite(time)) continue;
    if ((latest.get(key)?.time ?? -1) < time) latest.set(key, { level: String(alert.level), time, name: entity?.name ?? code, code, signal });
  }
  const byCountry = new Map<string, InternetOutage>();
  for (const entry of latest.values()) {
    if (entry.level !== "critical") continue;
    const outage = byCountry.get(entry.code) ?? { code: entry.code, country: entry.name, since: new Date(entry.time * 1000).toISOString(), signals: [] };
    outage.signals.push(entry.signal);
    if (new Date(entry.time * 1000).toISOString() < outage.since) outage.since = new Date(entry.time * 1000).toISOString();
    byCountry.set(entry.code, outage);
  }
  return [...byCountry.values()].sort((a, b) => b.signals.length - a.signals.length || a.country.localeCompare(b.country));
}

// ---------- the combined picture ----------

export interface ProviderStatus {
  name: string;
  what: string;
  page: string;
  error: string | null;
  outages: Outage[];
}

export interface OutagePicture {
  updatedAt: string;
  providers: ProviderStatus[];
  internet: InternetOutage[];
  internetError: string | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function outagePicture(now: Date): Promise<OutagePicture> {
  const [results, ioda] = await Promise.all([
    Promise.allSettled(PROVIDERS.map(async (provider) => provider.parse(provider.bytes ? await fetchBytes(provider.url) : await getText(provider.url)))),
    getText(IODA_URL(now)).then(parseIoda, (error: unknown) => message(error)),
  ]);
  return {
    updatedAt: now.toISOString(),
    providers: PROVIDERS.map((provider, index) => {
      const result = results[index]!;
      return {
        name: provider.name,
        what: provider.what,
        page: provider.page,
        error: result.status === "rejected" ? message(result.reason) : null,
        outages: result.status === "fulfilled" ? result.value.map((outage) => ageAdjusted(outage, now)) : [],
      };
    }),
    internet: typeof ioda === "string" ? [] : ioda,
    internetError: typeof ioda === "string" ? ioda : null,
  };
}

// Long-running incidents are kept, but at low severity so they do not page anyone.
function ageAdjusted(outage: Outage, now: Date): Outage {
  const age = outage.started ? now.getTime() - Date.parse(outage.started) : 0;
  return age > STALE_MS ? { ...outage, severity: "low" } : outage;
}

const CACHE_KEY = "outage_cache";
const CACHE_MS = 2 * 60_000;

export async function cachedOutagePicture(db: D1Database, now: Date = new Date()): Promise<OutagePicture> {
  const cached = JSON.parse((await getSetting(db, CACHE_KEY)) ?? "null") as OutagePicture | null;
  if (cached && now.getTime() - Date.parse(cached.updatedAt) < CACHE_MS) return cached;
  const picture = await outagePicture(now);
  await setSetting(db, CACHE_KEY, JSON.stringify(picture));
  return picture;
}

// ---------- alerts ----------

const COUNTRY_ALIASES: Record<string, string> = { UK: "GB" };
const RELIABLE_SIGNALS = ["bgp", "ping-slash24"];

export async function outageItems(picture: OutagePicture, sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  const expiresAt = new Date(now.getTime() + 45 * 60_000).toISOString();
  for (const provider of picture.providers) {
    const what = PROVIDERS.find((each) => each.name === provider.name)?.what ?? "";
    // Minor, regional and long-running problems stay on the status board.
    for (const outage of provider.outages.filter((each) => each.severity !== "low")) {
      items.push(
        await hazardItem({
          // The severity is part of the key, so a worsening outage alerts again.
          key: `outage:${provider.name}:${outage.id}:${outage.severity}`,
          source: "outages",
          category: "cyber",
          severity: outage.severity,
          title: truncate(`${provider.name} outage: ${outage.title}`, 200),
          summary: truncate(
            `${provider.name} (${what}) reports a problem${outage.status ? ` (${outage.status})` : ""}: ${outage.title}.${outage.detail ? ` Latest: ${outage.detail}` : ""}`,
            600,
          ),
          incident: truncate(`${provider.name} outage: ${outage.title}`, 120),
          url: outage.url,
          author: `${provider.name} status page`,
          publishedAt: outage.started,
          place: "",
          expiresAt,
          ongoing: true,
        }),
      );
    }
  }
  for (const outage of picture.internet) {
    // Google's traffic signal alone gives false alarms; routing or probing must agree.
    if (!outage.signals.some((signal) => RELIABLE_SIGNALS.includes(signal))) continue;
    const site = sites.find((each) => (COUNTRY_ALIASES[each.country.toUpperCase()] ?? each.country.toUpperCase()) === outage.code);
    if (!site) continue;
    items.push(
      await hazardItem({
        key: `ioda:${outage.code}:${outage.since}`,
        source: "outages",
        category: "cyber",
        severity: outage.signals.filter((signal) => RELIABLE_SIGNALS.includes(signal)).length >= 2 ? "high" : "medium",
        title: `Internet outage detected in ${outage.country}`,
        summary: `IODA detects a country-wide internet disruption in ${outage.country} since ${outage.since.slice(11, 16)} UTC (seen in ${outage.signals.join(", ")}), where ${site.name} is. Causes include cable cuts, power failures, cyber attacks and government shutdowns.`,
        incident: `Internet outage in ${outage.country}`,
        url: `https://ioda.inetintel.cc.gatech.edu/country/${outage.code}`,
        author: "IODA (Georgia Tech)",
        publishedAt: outage.since,
        place: outage.country,
        lat: site.lat,
        lon: site.lon,
        site: site.name,
        distanceMi: null,
        expiresAt,
        ongoing: true,
      }),
    );
  }
  return items;
}

export async function outageHazards(db: D1Database, sites: Site[], now: Date): Promise<HazardItem[]> {
  const picture = await outagePicture(now);
  await setSetting(db, CACHE_KEY, JSON.stringify(picture));
  if (picture.providers.every((provider) => provider.error) && picture.internetError) throw new Error("No outage source answered");
  return outageItems(picture, sites, now);
}
