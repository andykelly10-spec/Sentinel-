import { announcedIncidents, markSent, pendingAlerts } from "../db";
import type { Env } from "../types";
import { sendEmail } from "./email";
import { groupForNotification } from "./group";
import { needsEmail, needsSms, recipients } from "./rules";
import { sendSms, smsBodies } from "./sms";

const WINDOW_MS = 86_400_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.SENDGRID_API_KEY && env.ALERT_EMAIL_FROM && recipients(env.ALERT_EMAIL_TO).length);
}

export function smsConfigured(env: Env): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER && recipients(env.ALERT_SMS_TO).length,
  );
}

// Sends whatever has not gone out yet, so a failed send is retried on the
// next run. Returns the errors encountered.
export async function notify(env: Env, now: Date): Promise<string[]> {
  const errors: string[] = [];
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const sentAt = now.toISOString();

  if (emailConfigured(env)) {
    try {
      const alerts = (await pendingAlerts(env.DB, "emailed_at", since)).filter((alert) =>
        needsEmail(alert, env.MIN_EMAIL_SEVERITY),
      );
      const groups = groupForNotification(alerts, await announcedIncidents(env.DB, "emailed_at", since));
      if (groups.length > 0) {
        await sendEmail(env.SENDGRID_API_KEY!, env.ALERT_EMAIL_FROM, recipients(env.ALERT_EMAIL_TO), groups, env.DASHBOARD_URL);
      }
      // Further reports of an incident already announced are marked without sending.
      await markSent(env.DB, "emailed_at", alerts.map((alert) => alert.id), sentAt);
    } catch (error) {
      errors.push(`Email: ${message(error)}`);
    }
  }

  if (smsConfigured(env)) {
    try {
      const alerts = (await pendingAlerts(env.DB, "sms_at", since)).filter(needsSms);
      const groups = groupForNotification(alerts, await announcedIncidents(env.DB, "sms_at", since));
      let reached = groups.length === 0;
      if (groups.length > 0) {
        const bodies = smsBodies(groups, env.DASHBOARD_URL);
        const results = await Promise.allSettled(
          recipients(env.ALERT_SMS_TO).flatMap((to) =>
            bodies.map((body) =>
              sendSms(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!, env.TWILIO_FROM_NUMBER, to, body),
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") errors.push(`SMS: ${message(result.reason)}`);
        }
        // Counted as sent once anyone was reached, so a single bad number
        // cannot make every run re-text the rest of the team.
        reached = results.some((result) => result.status === "fulfilled");
      }
      if (reached) {
        await markSent(env.DB, "sms_at", alerts.map((alert) => alert.id), sentAt);
      }
    } catch (error) {
      errors.push(`SMS: ${message(error)}`);
    }
  }

  return errors;
}
