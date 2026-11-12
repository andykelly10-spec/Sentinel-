import { escapeHtml, isHttpUrl } from "../text";
import type { Alert } from "../types";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#b42318",
  high: "#c4500c",
  medium: "#93650a",
  low: "#52606d",
};

export function emailSubject(alerts: Alert[]): string {
  const critical = alerts.filter((alert) => alert.severity === "critical").length;
  const count = `${alerts.length} new alert${alerts.length === 1 ? "" : "s"}`;
  return critical > 0 ? `[Sentinel] ${count} (${critical} critical)` : `[Sentinel] ${count}`;
}

function origin(alert: Alert): string {
  return [alert.author, alert.source.replace("_", " ")].filter(Boolean).join(" via ");
}

export function emailText(alerts: Alert[], dashboardUrl: string): string {
  const blocks = alerts.map((alert) =>
    [
      `[${alert.severity.toUpperCase()}] ${alert.category}: ${alert.title}`,
      alert.summary,
      `${origin(alert)} | ${alert.url}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (dashboardUrl) blocks.push(`Dashboard: ${dashboardUrl}`);
  return blocks.join("\n\n");
}

export function emailHtml(alerts: Alert[], dashboardUrl: string): string {
  const rows = alerts
    .map((alert) => {
      const color = SEVERITY_COLORS[alert.severity] ?? "#52606d";
      const title = isHttpUrl(alert.url)
        ? `<a href="${escapeHtml(alert.url)}" style="color:#1a1f36;">${escapeHtml(alert.title)}</a>`
        : escapeHtml(alert.title);
      return `<tr><td style="padding:14px 0;border-bottom:1px solid #e3e8ee;">
<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${color};">${escapeHtml(alert.severity)} &middot; ${escapeHtml(alert.category)}</div>
<div style="font-size:16px;font-weight:600;margin:4px 0;">${title}</div>
<div style="font-size:14px;color:#3c4257;">${escapeHtml(alert.summary)}</div>
<div style="font-size:12px;color:#697386;margin-top:6px;">${escapeHtml(origin(alert))}</div>
</td></tr>`;
    })
    .join("");
  const footer = isHttpUrl(dashboardUrl)
    ? `<p style="font-size:13px;"><a href="${escapeHtml(dashboardUrl)}">Open the Sentinel dashboard</a></p>`
    : "";
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1f36;max-width:640px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>${footer}</div>`;
}

export async function sendEmail(
  apiKey: string,
  from: string,
  to: string[],
  alerts: Alert[],
  dashboardUrl: string,
): Promise<void> {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: to.map((email) => ({ to: [{ email }] })),
      from: { email: from, name: "Sentinel" },
      subject: emailSubject(alerts),
      content: [
        { type: "text/plain", value: emailText(alerts, dashboardUrl) },
        { type: "text/html", value: emailHtml(alerts, dashboardUrl) },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SendGrid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}
