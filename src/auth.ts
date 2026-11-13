import { escapeHtml } from "./text";

const COOKIE = "sentinel_session";
const SESSION_MS = 30 * 86_400_000;
// Failed sign-ins allowed per address in each window before it is locked out.
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

// Sessions are signed with a key derived from the password, so changing the
// password signs everyone out.
async function sessionKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`sentinel-session|${password}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createSession(password: string, now: number): Promise<string> {
  const expires = String(now + SESSION_MS);
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(password), encoder.encode(expires));
  return `${expires}.${base64url(signature)}`;
}

export async function validSession(token: string, password: string, now: number): Promise<boolean> {
  const [expires, signature] = token.split(".");
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) <= now) return false;
  const bytes = fromBase64url(signature);
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", await sessionKey(password), bytes, encoder.encode(expires));
}

export async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
  // Comparing digests keeps the comparison time independent of the password.
  const [a, b] = await Promise.all(
    [supplied, expected].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))),
  );
  let diff = 0;
  for (let i = 0; i < a!.length; i++) diff |= a![i]! ^ b![i]!;
  return diff === 0;
}

export function readCookie(request: Request, name = COOKIE): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Scripts can still send the password with HTTP Basic authentication; the
// browser never sees a challenge for it, so it never shows its own prompt.
export async function basicMatches(request: Request, password: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  return separator !== -1 && passwordMatches(decoded.slice(separator + 1), password);
}

const LOGIN_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function loginPage(message: string | null, status: number): Response {
  const notice = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sentinel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: radial-gradient(circle at 50% 30%, #12171d, #07090b 70%); color: #dfe3e8; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: 100%; max-width: 360px; padding: 32px 28px; border-radius: 12px; background: rgba(12, 15, 18, 0.92); border: 1px solid rgba(255, 255, 255, 0.09); }
  .brand { display: flex; align-items: center; gap: 12px; color: #e3ab35; margin-bottom: 26px; }
  svg { width: 38px; height: 38px; filter: drop-shadow(0 0 6px rgba(227, 171, 53, 0.6)); }
  h1 { margin: 0; font: 500 20px ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.42em; }
  .sub { font: 10px ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.3em; text-transform: uppercase; opacity: 0.85; }
  label { display: block; font: 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: #8a93a0; margin-bottom: 8px; }
  input[type=password] { width: 100%; font: inherit; font-size: 16px; padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.16); background: #07090b; color: #dfe3e8; }
  input[type=password]:focus { outline: 2px solid #2fd3e6; outline-offset: 1px; }
  button { width: 100%; margin-top: 16px; padding: 12px; border-radius: 999px; border: 1px solid #e3ab35; background: rgba(227, 171, 53, 0.12); color: #e3ab35; font: 600 12px ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.18em; text-transform: uppercase; cursor: pointer; }
  button:hover { background: rgba(227, 171, 53, 0.22); }
  button:focus-visible { outline: 2px solid #2fd3e6; outline-offset: 2px; }
  .error { margin: 0 0 14px; padding: 10px 12px; border-radius: 6px; border: 1px solid rgba(255, 82, 82, 0.5); color: #ffb4b4; font-size: 13px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <div class="brand">
    <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/><circle cx="20" cy="20" r="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".7"/><circle cx="20" cy="20" r="3" fill="currentColor"/><path d="M20 20 L34 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <div><h1>Sentinel</h1><div class="sub">Security intelligence</div></div>
  </div>
  ${notice}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": LOGIN_POLICY,
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
