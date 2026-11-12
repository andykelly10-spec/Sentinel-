import { latestRun, listAlerts, openCounts, setAlertStatus } from "./db";
import { emailConfigured, smsConfigured } from "./notify";
import { runPipeline } from "./pipeline";
import { sha256Hex } from "./text";
import { ALERT_CATEGORIES, SEVERITIES, type Alert, type Env } from "./types";

const STATUSES: Array<Alert["status"]> = ["new", "acknowledged", "dismissed"];
const CATEGORY_FILTERS: string[] = [...ALERT_CATEGORIES, "unclassified"];

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
      limit: 200,
    });
    return json({ alerts });
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    const [lastRun, open] = await Promise.all([latestRun(env.DB), openCounts(env.DB)]);
    return json({ lastRun, open, email: emailConfigured(env), sms: smsConfigured(env) });
  }

  if (request.method === "POST") {
    // Browsers attach saved Basic credentials to cross-site requests.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Cross-origin request refused" }, 403);

    if (url.pathname === "/api/run") {
      return json({ run: await runPipeline(env) });
    }

    const match = url.pathname.match(/^\/api\/alerts\/([0-9a-f]{32})\/status$/);
    if (match) {
      const body = (await request.json().catch(() => null)) as { status?: string } | null;
      const status = pick(body?.status ?? null, STATUSES) as Alert["status"] | undefined;
      if (!status) return json({ error: "status must be new, acknowledged or dismissed" }, 400);
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
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const run = await runPipeline(env);
    console.log(
      `run fetched=${run.fetched} new=${run.newItems} alerts=${run.alerts} errors=${JSON.stringify(run.errors)}`,
    );
  },
} satisfies ExportedHandler<Env>;
