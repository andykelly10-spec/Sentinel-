import { truncate } from "../text";
import type { Alert } from "../types";

const MAX_INDIVIDUAL = 3;

// A burst of urgent alerts becomes one text rather than a flood.
export function smsBodies(alerts: Alert[], dashboardUrl: string): string[] {
  const link = dashboardUrl ? ` ${dashboardUrl}` : "";
  if (alerts.length > MAX_INDIVIDUAL) {
    const critical = alerts.filter((alert) => alert.severity === "critical").length;
    return [`Sentinel: ${alerts.length} urgent alerts (${critical} critical). Check the dashboard now.${link}`];
  }
  return alerts.map(
    (alert) =>
      `Sentinel ${alert.severity.toUpperCase()} ${alert.category}: ${truncate(alert.summary || alert.title, 240)}${link}`,
  );
}

export async function sendSms(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Twilio HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}
