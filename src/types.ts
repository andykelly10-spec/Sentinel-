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

export interface Site {
  id: number;
  name: string;
  address: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  area: string;
  keywords: string;
  priority: boolean;
  approximate: boolean;
  // Filled in by the hazard check; see migrations/0004.
  nws_zones: string | null;
  region: string;
}

export type NewSite = Omit<Site, "id" | "nws_zones" | "region">;

export type SourceName =
  | "bing_news"
  | "bing_local"
  | "google_news"
  | "bluesky"
  | "bluesky_urgent"
  | "lemmy"
  | "hackernews"
  | "rss"
  | "nws"
  | "usgs"
  | "wildfire"
  | "gdacs"
  | "aircraft"
  | "faa_tfr"
  | "travel_advisory"
  | "domains";

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

export const ALERT_CATEGORIES = ["physical", "cyber", "brand", "executive", "hazard"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];
export type Category = AlertCategory | "unclassified" | "none";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Classification {
  category: Category;
  severity: Severity;
  summary: string;
  // A short shared name for the real-world event, so reports of it group together.
  incident: string;
  place: string;
  lat: number | null;
  lon: number | null;
}

export interface ClassifiedItem extends Candidate, Classification {
  site: string;
  distanceMi: number | null;
}

export interface Alert extends ClassifiedItem {
  firstSeenAt: string;
  status: AlertStatus;
  expiresAt: string | null;
}

export const ALERT_STATUSES = ["new", "acknowledged", "dismissed", "expired"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

// Produced by rules rather than the classifier.
export interface HazardItem extends ClassifiedItem {
  expiresAt: string | null;
  // Ongoing hazards push their expiry forward each time they are seen again.
  ongoing: boolean;
}

export interface SourceResult {
  source: SourceName;
  count: number;
  error: string | null;
}

export function severityRank(severity: string): number {
  return SEVERITIES.indexOf(severity as Severity);
}
