import { writeBrief } from "./brief";
import { createClient } from "./classify";
import { hourlyActivity, latestBrief, latestRun, listAlerts, listSites, openCounts, saveSites, setAlertStatus, setIncidentStatus } from "./db";
import { proxyFeed } from "./feeds";
import { runHazards } from "./hazards";
import { emailConfigured, smsConfigured } from "./notify";
import { runPipeline } from "./pipeline";
import { BRIEF_CRON, HAZARD_CRON, HOURLY_MINUTE } from "./schedule";
import { locateSites, parseSitesCsv } from "./sites";
import { sha256Hex } from "./text";
import { ALERT_CATEGORIES, ALERT_STATUSES, SEVERITIES, type AlertStatus, type Env } from "./types";

const STATUSES: readonly string[] = ALERT_STATUSES;
const CATEGORY_FILTERS: string[] = [...ALERT_CATEGORIES, "unclassified"];

// The page runs only its own scripts. It talks to this worker, plus Transport
// for London's camera list, which refuses requests relayed from Cloudflare.
// Map tiles and camera stills are the only other things loaded from elsewhere.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.tfl.gov.uk; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
  // Comparing digests keeps the comparison time independent of the password.
  const [a, b] = await Promise.all([sha256Hex(supplied), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorized(request: Request, password: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  return passwordMatches(decoded.slice(separator + 1), password);
}

function pick(value: string | null, allowed: readonly string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/alerts") {
    const alerts = await listAlerts(env.DB, {
      category: pick(url.searchParams.get("category"), CATEGORY_FILTERS),
      severity: pick(url.searchParams.get("severity"), SEVERITIES),
      status: pick(url.searchParams.get("status"), STATUSES),
      limit: 300,
    });
    return json({ alerts });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/feeds/")) {
    return proxyFeed(url.pathname.slice("/api/feeds/".length), url.searchParams);
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const [lastRun, lastHazardRun, open, activity, sites] = await Promise.all([
      latestRun(env.DB, "news"),
      latestRun(env.DB, "hazards"),
      openCounts(env.DB),
      hourlyActivity(env.DB, dayAgo),
      listSites(env.DB),
    ]);
    return json({ lastRun, lastHazardRun, open, activity, sites, email: emailConfigured(env), sms: smsConfigured(env) });
  }

  if (request.method === "GET" && url.pathname === "/api/brief") {
    return json({ brief: await latestBrief(env.DB) });
  }

  if (request.method === "POST") {
    // Browsers attach saved Basic credentials to cross-site requests.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Cross-origin request refused" }, 403);

    if (url.pathname === "/api/run") {
      return json({ run: await runPipeline(env) });
    }

    if (url.pathname === "/api/hazards/run") {
      return json({ run: await runHazards(env, new Date(), true) });
    }

    if (url.pathname === "/api/brief") {
      try {
        return json({ brief: await writeBrief(env) });
      } catch (error) {
        console.error("Brief failed:", error);
        return json({ error: "The brief could not be written. Check that the Anthropic API key is set and try again." }, 502);
      }
    }

    if (url.pathname === "/api/sites/import") {
      const body = (await request.json().catch(() => null)) as { csv?: string; replace?: boolean } | null;
      if (typeof body?.csv !== "string") return json({ error: "csv is required" }, 400);
      let parsed;
      try {
        parsed = parseSitesCsv(body.csv);
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      const located = await locateSites(createClient(env.ANTHROPIC_API_KEY), env.CLASSIFIER_MODEL, parsed);
      if (located.sites.length === 0) return json({ error: "No usable rows were found.", skipped: located.skipped }, 400);
      await saveSites(env.DB, located.sites, body.replace !== false);
      return json({
        imported: located.sites.length,
        estimated: located.sites.filter((site) => site.approximate).length,
        skipped: located.skipped,
      });
    }

    if (url.pathname === "/api/incidents/status") {
      const body = (await request.json().catch(() => null)) as { incident?: string; status?: string } | null;
      const status = pick(body?.status ?? null, STATUSES) as AlertStatus | undefined;
      if (!status || !body?.incident) return json({ error: "incident and a valid status are required" }, 400);
      const updated = await setIncidentStatus(env.DB, body.incident, status);
      return updated ? json({ ok: true }) : json({ error: "Incident not found" }, 404);
    }

    const match = url.pathname.match(/^\/api\/alerts\/([0-9a-f]{32})\/status$/);
    if (match) {
      const body = (await request.json().catch(() => null)) as { status?: string } | null;
      const status = pick(body?.status ?? null, STATUSES) as AlertStatus | undefined;
      if (!status) return json({ error: `status must be one of: ${STATUSES.join(", ")}` }, 400);
      const updated = await setAlertStatus(env.DB, match[1]!, status);
      return updated ? json({ ok: true }) : json({ error: "Alert not found" }, 404);
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.DASHBOARD_PASSWORD) {
      return new Response("Sentinel is not configured: set the DASHBOARD_PASSWORD secret.", { status: 503 });
    }
    if (!(await authorized(request, env.DASHBOARD_PASSWORD))) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Sentinel", charset="UTF-8"' },
      });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("API error:", error);
        return json({ error: "Internal error" }, 500);
      }
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(asset.body, { status: asset.status, headers });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === HAZARD_CRON) {
      const hourly = new Date(controller.scheduledTime).getUTCMinutes() === HOURLY_MINUTE;
      const run = await runHazards(env, new Date(controller.scheduledTime), hourly);
      console.log(`hazards found=${run.fetched} new=${run.newItems} errors=${JSON.stringify(run.errors)}`);
      return;
    }
    if (controller.cron === BRIEF_CRON) {
      const brief = await writeBrief(env);
      console.log(`brief ${brief.id} written${brief.emailError ? `, email failed: ${brief.emailError}` : ""}`);
      return;
    }
    const run = await runPipeline(env);
    console.log(
      `run fetched=${run.fetched} new=${run.newItems} alerts=${run.alerts} errors=${JSON.stringify(run.errors)}`,
    );
  },
} satisfies ExportedHandler<Env>;
