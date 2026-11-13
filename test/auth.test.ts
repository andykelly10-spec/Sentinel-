import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createSession, MAX_FAILURES, validSession } from "../src/auth";
import { createEnv } from "./helpers";
import type { Env } from "../src/types";

const ORIGIN = "https://sentinel.example";

function login(env: Env, password: string, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      body: new URLSearchParams({ password }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...headers },
    }),
    env,
  );
}

const sessionFrom = (response: Response) => response.headers.get("Set-Cookie")!.split(";")[0]!;

describe("sign-in", () => {
  it("shows a password-only form instead of the browser's username prompt", async () => {
    const env = createEnv();
    const page = await worker.fetch(new Request(`${ORIGIN}/`), env);
    expect(page.status).toBe(401);
    expect(page.headers.get("WWW-Authenticate")).toBeNull();
    const html = await page.text();
    expect(html).toContain('type="password"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).not.toContain("username");
    expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self'");

    const api = await worker.fetch(new Request(`${ORIGIN}/api/alerts`), env);
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "Sign in required" });
    expect(api.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("signs in with the right password and keeps the session in a secure cookie", async () => {
    const env = createEnv();
    const wrong = await login(env, "nope");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("That password is not right.");

    const right = await login(env, "hunter2");
    expect(right.status).toBe(303);
    expect(right.headers.get("Location")).toBe("/");
    const cookie = right.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^sentinel_session=\d+\.[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);

    const page = await worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: { Cookie: sessionFrom(right) } }), env);
    expect(page.status).toBe(200);
  });

  it("rejects tampered and expired sessions, and sessions from before a password change", async () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const token = await createSession("hunter2", now);
    expect(await validSession(token, "hunter2", now)).toBe(true);
    expect(await validSession(token, "hunter2", now + 31 * 86_400_000)).toBe(false);
    expect(await validSession(token, "new-password", now)).toBe(false);
    const [expires, signature] = token.split(".");
    expect(await validSession(`${Number(expires) + 1}.${signature}`, "hunter2", now)).toBe(false);
    expect(await validSession("garbage", "hunter2", now)).toBe(false);

    const env = createEnv();
    const forged = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: `sentinel_session=${expires}.AAAA` } }), env);
    expect(forged.status).toBe(401);
  });

  it("signs out", async () => {
    const env = createEnv();
    const out = await worker.fetch(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: ORIGIN } }), env);
    expect(out.status).toBe(303);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const crossSite = await worker.fetch(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: "https://evil.example" } }), env);
    expect(crossSite.status).toBe(403);
  });

  it("locks an address out after repeated wrong passwords", async () => {
    const env = createEnv();
    const from = { "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login(env, "wrong", from)).status).toBe(401);
    const locked = await login(env, "hunter2", from);
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many wrong passwords");
    // Another address is unaffected.
    expect((await login(env, "hunter2", { "CF-Connecting-IP": "203.0.113.10" })).status).toBe(303);
  });

  it("refuses sign-in posted from another site", async () => {
    const env = createEnv();
    expect((await login(env, "hunter2", { Origin: "https://evil.example" })).status).toBe(403);
  });

  it("still accepts the password from scripts using basic authentication", async () => {
    const env = createEnv();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: { Authorization: `Basic ${btoa(":hunter2")}` } }), env);
    expect(response.status).toBe(200);
    const wrong = await worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: { Authorization: `Basic ${btoa(":nope")}` } }), env);
    expect(wrong.status).toBe(401);
  });

  it("serves the dashboard once signed in", async () => {
    const env = createEnv();
    const session = sessionFrom(await login(env, "hunter2"));
    const page = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: session } }), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("asset");
    expect((await worker.fetch(new Request(`${ORIGIN}/`), createEnv({ DASHBOARD_PASSWORD: undefined }))).status).toBe(503);
  });
});
