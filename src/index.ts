import {
  basicMatches,
  clearedCookie,
  createSession,
  FAILURE_WINDOW_MS,
  loginPage,
  MAX_FAILURES,
  passwordMatches,
  readCookie,
  sessionCookie,
  validSession,
} from "./auth";
import { writeBrief } from "./brief";
import { createClient } from "./classify";
import {
  getSetting,
  hourlyActivity,
  latestBrief,
  latestRun,
  listAlerts,
  listSites,
  openCounts,
  saveSites,
  setAlertStatus,
  setIncidentStatus,
  setSetting,
} from "./db";
import { proxyFeed } from "./feeds";
import { latestHeadlines } from "./headlines";
import { liveVideos } from "./live";
import { cachedAirRaidPicture } from "./hazards/airRaids";
import { activeLocation, clearMyLocation, updateMyLocation, validUpdate } from "./me";
import { runHazards, runOutages } from "./hazards";
import { cachedOutagePicture } from "./hazards/outages";
import { emailConfigured, smsConfigured } from "./notify";
import { runPipeline } from "./pipeline";
import { BRIEF_CRON, HAZARD_CRON, HOURLY_MINUTE, OUTAGE_CRON } from "./schedule";
import { locateSites, parseSitesCsv } from "./sites";
import { ALERT_CATEGORIES, ALERT_STATUSES, SEVERITIES, type AlertStatus, type Env } from "./types";

const STATUSES: readonly string[] = ALERT_STATUSES;
const CATEGORY_FILTERS: string[] = [...ALERT_CATEGORIES, "unclassified"];

// The page runs only its own scripts. It talks to this worker, plus Transport
// for London's camera list, which refuses requests relayed from Cloudflare.
// Map tiles and camera stills are loaded from elsewhere, and the live TV wall
// embeds YouTube players.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.tfl.gov.uk; frame-src https://www.youtube.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function pick(value: string | null, allowed: readonly string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined;
}

async function handleApi(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
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
    const [lastRun, lastHazardRun, lastOutageRun, open, activity, sites, me] = await Promise.all([
      latestRun(env.DB, "news"),
      latestRun(env.DB, "hazards"),
      latestRun(env.DB, "outages"),
      openCounts(env.DB),
      hourlyActivity(env.DB, dayAgo),
      listSites(env.DB),
      activeLocation(env.DB, new Date()),
    ]);
    return json({ lastRun, lastHazardRun, lastOutageRun, open, activity, sites, me, email: emailConfigured(env), sms: smsConfigured(env) });
  }

  if (request.method === "GET" && url.pathname === "/api/headlines") {
    return json(await latestHeadlines(env.DB));
  }

  if (request.method === "GET" && url.pathname === "/api/live") {
    const fresh = url.searchParams.get("fresh") === "1";
    return json({ videos: await liveVideos(env.DB, (url.searchParams.get("channels") ?? "").split(","), new Date(), fresh) });
  }

  if (request.method === "GET" && url.pathname === "/api/outages") {
    return json(await cachedOutagePicture(env.DB));
  }

  if (request.method === "GET" && url.pathname === "/api/airraids") {
    return json(await cachedAirRaidPicture(env.DB));
  }

  if (request.method === "GET" && url.pathname === "/api/brief") {
    return json({ brief: await latestBrief(env.DB) });
  }

  if (request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Cross-origin request refused" }, 403);

    if (url.pathname === "/api/run") {
      return json({ run: await runPipeline(env) });
    }

    // Alerts near you: the dashboard sends your position while you watch it.
    if (url.pathname === "/api/me") {
      const update = validUpdate(await request.json().catch(() => null));
      if (!update) return json({ error: "lat and lon are required" }, 400);
      const now = new Date();
      const { location, moved } = await updateMyLocation(env.DB, update, now);
      // After a move, check the new area straight away rather than at the next scheduled run.
      if (moved && ctx) ctx.waitUntil(runHazards(env, now).catch((error) => console.error("Near-you check failed:", error)));
      return json({ location, checking: moved });
    }

    if (url.pathname === "/api/me/off") {
      await clearMyLocation(env.DB);
      return json({ ok: true });
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

function sameOrigin(request: Request, url: URL): boolean {
  // Browsers attach cookies to some cross-site requests; refuse those that change things.
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!sameOrigin(request, url)) return loginPage("Please sign in from the Sentinel page.", 403);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `login_failures:${ip}`;
  const now = Date.now();
  const stored = JSON.parse((await getSetting(env.DB, key)) ?? "null") as { count: number; first: number } | null;
  const failures = stored && now - stored.first < FAILURE_WINDOW_MS ? stored : { count: 0, first: now };
  if (failures.count >= MAX_FAILURES) {
    const minutes = Math.ceil((failures.first + FAILURE_WINDOW_MS - now) / 60_000);
    return loginPage(`Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429);
  }

  const form = await request.formData().catch(() => null);
  const supplied = form?.get("password");
  if (typeof supplied === "string" && (await passwordMatches(supplied, env.DASHBOARD_PASSWORD!))) {
    if (stored) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Set-Cookie": sessionCookie(await createSession(env.DASHBOARD_PASSWORD!, now)), "Cache-Control": "no-store" },
    });
  }
  await setSetting(env.DB, key, JSON.stringify({ count: failures.count + 1, first: failures.first }));
  return loginPage("That password is not right.", 401);
}

async function signedIn(request: Request, password: string): Promise<boolean> {
  const token = readCookie(request);
  if (token && (await validSession(token, password, Date.now()))) return true;
  return basicMatches(request, password);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (!env.DASHBOARD_PASSWORD) {
      return new Response("Sentinel is not configured: set the DASHBOARD_PASSWORD secret.", { status: 503 });
    }
    const url = new URL(request.url);

    if (url.pathname === "/login" && request.method === "POST") return handleLogin(request, env, url);
    if (url.pathname === "/logout" && request.method === "POST") {
      if (!sameOrigin(request, url)) return json({ error: "Cross-origin request refused" }, 403);
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearedCookie() } });
    }

    if (!(await signedIn(request, env.DASHBOARD_PASSWORD))) {
      return url.pathname.startsWith("/api/") ? json({ error: "Sign in required" }, 401) : loginPage(null, 401);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (error) {
        console.error("API error:", error);
        return json({ error: "Internal error" }, 500);
      }
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    // "same-origin" so the browser sends this page's Origin on its own POSTs
    // (no-referrer would send "Origin: null" and fail the same-origin check).
    headers.set("Referrer-Policy", "same-origin");
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
    if (controller.cron === OUTAGE_CRON) {
      const run = await runOutages(env, new Date(controller.scheduledTime));
      console.log(`outages found=${run.fetched} new=${run.newItems} errors=${JSON.stringify(run.errors)}`);
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
