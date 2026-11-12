export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  ANTHROPIC_API_KEY: string;
  DASHBOARD_PASSWORD?: string;
  SENDGRID_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;

  CLASSIFIER_MODEL: string;
  MIN_EMAIL_SEVERITY: string;
  DASHBOARD_URL: string;
  ALERT_EMAIL_FROM: string;
  ALERT_EMAIL_TO: string;
  ALERT_SMS_TO: string;
  TWILIO_FROM_NUMBER: string;
}

export type SourceName = "bing_news" | "google_news" | "bluesky" | "lemmy" | "hackernews";

export interface RawItem {
  source: SourceName;
  url: string;
  title: string;
  snippet: string;
  author: string;
  publishedAt: string | null;
}

export interface Candidate extends RawItem {
  id: string;
}

export const ALERT_CATEGORIES = ["physical", "cyber", "brand", "executive"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];
export type Category = AlertCategory | "unclassified" | "none";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Classification {
  category: Category;
  severity: Severity;
  summary: string;
}

export interface ClassifiedItem extends Candidate, Classification {}

export interface Alert extends ClassifiedItem {
  firstSeenAt: string;
  status: "new" | "acknowledged" | "dismissed";
}

export interface SourceResult {
  source: SourceName;
  count: number;
  error: string | null;
}

export function severityRank(severity: string): number {
  return SEVERITIES.indexOf(severity as Severity);
}
