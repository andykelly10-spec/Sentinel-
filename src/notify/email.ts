import { proximityLabel } from "../geo";
import { escapeHtml, isHttpUrl } from "../text";
import type { AlertGroup } from "./group";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#b42318",
  high: "#c4500c",
  medium: "#93650a",
  low: "#52606d",
};

export function emailSubject(groups: AlertGroup[]): string {
  const critical = groups.filter((group) => group.alert.severity === "critical").length;
  const count = `${groups.length} new alert${groups.length === 1 ? "" : "s"}`;
  return critical > 0 ? `[Sentinel] ${count} (${critical} critical)` : `[Sentinel] ${count}`;
}

function headline({ alert, reports }: AlertGroup): string {
  return alert.incident ? `${alert.incident} (${reports} report${reports === 1 ? "" : "s"})` : alert.title;
}

function details({ alert }: AlertGroup): string {
  const origin = [alert.author, alert.source.replace("_", " ")].filter(Boolean).join(" via ");
  return [proximityLabel(alert.site, alert.distanceMi), origin].filter(Boolean).join(" | ");
}

export function emailText(groups: AlertGroup[], dashboardUrl: string): string {
  const blocks = groups.map((group) =>
    [
      `[${group.alert.severity.toUpperCase()}] ${group.alert.category}: ${headline(group)}`,
      group.alert.summary,
      `${details(group)} | ${group.alert.url}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (dashboardUrl) blocks.push(`Dashboard: ${dashboardUrl}`);
  return blocks.join("\n\n");
}

export function emailHtml(groups: AlertGroup[], dashboardUrl: string): string {
  const rows = groups
    .map((group) => {
      const { alert } = group;
      const color = SEVERITY_COLORS[alert.severity] ?? "#52606d";
      const title = isHttpUrl(alert.url)
        ? `<a href="${escapeHtml(alert.url)}" style="color:#1a1f36;">${escapeHtml(headline(group))}</a>`
        : escapeHtml(headline(group));
      return `<tr><td style="padding:14px 0;border-bottom:1px solid #e3e8ee;">
<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${color};">${escapeHtml(alert.severity)} &middot; ${escapeHtml(alert.category)}</div>
<div style="font-size:16px;font-weight:600;margin:4px 0;">${title}</div>
<div style="font-size:14px;color:#3c4257;">${escapeHtml(alert.summary)}</div>
<div style="font-size:12px;color:#697386;margin-top:6px;">${escapeHtml(details(group))}</div>
</td></tr>`;
    })
    .join("");
  const footer = isHttpUrl(dashboardUrl)
    ? `<p style="font-size:13px;"><a href="${escapeHtml(dashboardUrl)}">Open the Sentinel dashboard</a></p>`
    : "";
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1f36;max-width:640px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>${footer}</div>`;
}

export async function sendgridSend(
  apiKey: string,
  from: string,
  to: string[],
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: to.map((email) => ({ to: [{ email }] })),
      from: { email: from, name: "Sentinel" },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SendGrid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

export async function sendEmail(
  apiKey: string,
  from: string,
  to: string[],
  groups: AlertGroup[],
  dashboardUrl: string,
): Promise<void> {
  await sendgridSend(apiKey, from, to, emailSubject(groups), emailText(groups, dashboardUrl), emailHtml(groups, dashboardUrl));
}
