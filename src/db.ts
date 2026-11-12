import type { Alert, ClassifiedItem, SourceResult } from "./types";
import { SEVERITIES } from "./types";

// D1 allows at most 100 bound parameters per statement.
const MAX_PARAMS = 100;
// markSent binds one timestamp alongside the ids it marks.
const MAX_PENDING = MAX_PARAMS - 1;

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function placeholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

export async function findExistingIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const group of chunk(ids, MAX_PARAMS)) {
    const { results } = await db
      .prepare(`SELECT id FROM items WHERE id IN (${placeholders(group.length)})`)
      .bind(...group)
      .all<{ id: string }>();
    for (const row of results) existing.add(row.id);
  }
  return existing;
}

const ITEM_COLUMNS = 17;

export async function insertItems(db: D1Database, items: ClassifiedItem[], now: string): Promise<void> {
  if (items.length === 0) return;
  const row = `(${placeholders(ITEM_COLUMNS)})`;
  const statements = chunk(items, Math.floor(MAX_PARAMS / ITEM_COLUMNS)).map((group) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO items
           (id, source, url, title, snippet, author, published_at, first_seen_at, category, severity, summary,
            incident, place, lat, lon, site, distance_mi)
         VALUES ${group.map(() => row).join(", ")}`,
      )
      .bind(
        ...group.flatMap((item) => [
          item.id,
          item.source,
          item.url,
          item.title,
          item.snippet,
          item.author,
          item.publishedAt,
          now,
          item.category,
          item.severity,
          item.summary,
          item.incident,
          item.place,
          item.lat,
          item.lon,
          item.site,
          item.distanceMi,
        ]),
      ),
  );
  await db.batch(statements);
}

interface ItemRow {
  id: string;
  source: Alert["source"];
  url: string;
  title: string;
  snippet: string;
  author: string;
  published_at: string | null;
  first_seen_at: string;
  category: Alert["category"];
  severity: Alert["severity"];
  summary: string;
  status: Alert["status"];
  incident: string;
  place: string;
  lat: number | null;
  lon: number | null;
  site: string;
  distance_mi: number | null;
}

function toAlert(row: ItemRow): Alert {
  return {
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    author: row.author,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    category: row.category,
    severity: row.severity,
    summary: row.summary,
    status: row.status,
    incident: row.incident,
    place: row.place,
    lat: row.lat,
    lon: row.lon,
    site: row.site,
    distanceMi: row.distance_mi,
  };
}

const SEVERITY_ORDER = `CASE severity ${SEVERITIES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(" ")} END`;

export interface AlertFilter {
  category?: string;
  severity?: string;
  status?: string;
  limit: number;
}

export async function listAlerts(db: D1Database, filter: AlertFilter): Promise<Alert[]> {
  const where = ["category != 'none'"];
  const params: Array<string | number> = [];
  if (filter.category) {
    where.push("category = ?");
    params.push(filter.category);
  }
  if (filter.severity) {
    where.push("severity = ?");
    params.push(filter.severity);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  params.push(filter.limit);
  const { results } = await db
    .prepare(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY first_seen_at DESC, ${SEVERITY_ORDER} DESC LIMIT ?`)
    .bind(...params)
    .all<ItemRow>();
  return results.map(toAlert);
}

export async function setAlertStatus(db: D1Database, id: string, status: Alert["status"]): Promise<boolean> {
  const result = await db
    .prepare("UPDATE items SET status = ? WHERE id = ? AND category != 'none'")
    .bind(status, id)
    .run();
  return result.meta.changes > 0;
}

export async function setIncidentStatus(db: D1Database, incident: string, status: Alert["status"]): Promise<boolean> {
  const result = await db
    .prepare("UPDATE items SET status = ? WHERE incident = ? AND category != 'none'")
    .bind(status, incident)
    .run();
  return result.meta.changes > 0;
}

// Names of events that recent alerts were grouped under, newest first.
export async function recentIncidents(db: D1Database, since: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT incident FROM items
       WHERE incident != '' AND category != 'none' AND first_seen_at >= ?
       GROUP BY incident ORDER BY MAX(first_seen_at) DESC LIMIT 40`,
    )
    .bind(since)
    .all<{ incident: string }>();
  return results.map((row) => row.incident);
}

// For each incident already announced on a channel, the highest severity announced.
export async function announcedIncidents(
  db: D1Database,
  channel: "emailed_at" | "sms_at",
  since: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT incident, MAX(${SEVERITY_ORDER}) AS rank FROM items
       WHERE incident != '' AND ${channel} IS NOT NULL AND first_seen_at >= ?
       GROUP BY incident`,
    )
    .bind(since)
    .all<{ incident: string; rank: number }>();
  return new Map(results.map((row) => [row.incident, row.rank]));
}

export async function hourlyActivity(db: D1Database, since: string): Promise<Array<{ hour: string; alerts: number; scanned: number }>> {
  const { results } = await db
    .prepare(
      `SELECT substr(first_seen_at, 1, 13) AS hour,
              SUM(CASE WHEN category != 'none' THEN 1 ELSE 0 END) AS alerts,
              COUNT(*) AS scanned
       FROM items WHERE first_seen_at >= ? GROUP BY hour ORDER BY hour`,
    )
    .bind(since)
    .all<{ hour: string; alerts: number; scanned: number }>();
  return results;
}

// Alerts from the last day that have not gone out on the given channel yet.
export async function pendingAlerts(db: D1Database, channel: "emailed_at" | "sms_at", since: string): Promise<Alert[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM items
       WHERE category != 'none' AND status != 'dismissed' AND ${channel} IS NULL AND first_seen_at >= ?
       ORDER BY ${SEVERITY_ORDER} DESC, first_seen_at DESC
       LIMIT ${MAX_PENDING}`,
    )
    .bind(since)
    .all<ItemRow>();
  return results.map(toAlert);
}

export async function markSent(
  db: D1Database,
  channel: "emailed_at" | "sms_at",
  ids: string[],
  now: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .prepare(`UPDATE items SET ${channel} = ? WHERE id IN (${placeholders(ids.length)})`)
    .bind(now, ...ids)
    .run();
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  newItems: number;
  alerts: number;
  sources: SourceResult[];
  errors: string[];
}

const RUN_RETENTION_MS = 7 * 86_400_000;
// Sources only return items up to three days old, so non-alerts older than
// this can never be fetched again and no longer need to be remembered.
const NON_ALERT_RETENTION_MS = 14 * 86_400_000;

export async function recordRun(db: D1Database, run: RunRecord): Promise<void> {
  const finished = Date.parse(run.finishedAt);
  await db.batch([
    db
      .prepare(
        `INSERT INTO runs (started_at, finished_at, fetched, new_items, alerts, sources, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.startedAt,
        run.finishedAt,
        run.fetched,
        run.newItems,
        run.alerts,
        JSON.stringify(run.sources),
        JSON.stringify(run.errors),
      ),
    db.prepare("DELETE FROM runs WHERE started_at < ?").bind(new Date(finished - RUN_RETENTION_MS).toISOString()),
    db
      .prepare("DELETE FROM items WHERE category = 'none' AND first_seen_at < ?")
      .bind(new Date(finished - NON_ALERT_RETENTION_MS).toISOString()),
  ]);
}

export async function latestRun(db: D1Database): Promise<RunRecord | null> {
  const row = await db
    .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1")
    .first<{
      started_at: string;
      finished_at: string;
      fetched: number;
      new_items: number;
      alerts: number;
      sources: string;
      errors: string;
    }>();
  if (!row) return null;
  return {
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fetched: row.fetched,
    newItems: row.new_items,
    alerts: row.alerts,
    sources: JSON.parse(row.sources),
    errors: JSON.parse(row.errors),
  };
}

export async function openCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT severity, COUNT(*) AS n FROM items WHERE category != 'none' AND status = 'new' GROUP BY severity")
    .all<{ severity: string; n: number }>();
  return Object.fromEntries(results.map((row) => [row.severity, row.n]));
}
