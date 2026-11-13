// These must match the crons in wrangler.toml; a test checks that they do.
export const NEWS_CRON = "*/15 * * * *";
// Offset from the news check so the two never run at the same moment.
export const HAZARD_CRON = "7,22,37,52 * * * *";
// The hazard run at this minute also does the hourly checks.
export const HOURLY_MINUTE = 7;
// 12:03 UTC is 7:03 in New York in winter and 8:03 in summer.
export const BRIEF_CRON = "3 12 * * *";
