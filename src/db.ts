import type { Alert, AlertStatus, ClassifiedItem, HazardItem, NewSite, Site, SourceResult } from "./types";
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

const ITEM_COLUMNS = 18;

export async function insertItems(
  db: D1Database,
  items: Array<ClassifiedItem & { expiresAt?: string | null }>,
  now: string,
): Promise<void> {
  if (items.length === 0) return;
  const row = `(${placeholders(ITEM_COLUMNS)})`;
  const statements = chunk(items, Math.floor(MAX_PARAMS / ITEM_COLUMNS)).map((group) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO items
           (id, source, url, title, snippet, author, published_at, first_seen_at, category, severity, summary,
            incident, place, lat, lon, site, distance_mi, expires_at)
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
          item.expiresAt ?? null,
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
  expires_at: string | null;
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
    expiresAt: row.expires_at,
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

export async function setAlertStatus(db: D1Database, id: string, status: AlertStatus): Promise<boolean> {
  const result = await db
    .prepare("UPDATE items SET status = ? WHERE id = ? AND category != 'none'")
    .bind(status, id)
    .run();
  return result.meta.changes > 0;
}

export async function setIncidentStatus(db: D1Database, incident: string, status: AlertStatus): Promise<boolean> {
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
       WHERE category != 'none' AND status IN ('new', 'acknowledged') AND ${channel} IS NULL AND first_seen_at >= ?
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

export type RunKind = "news" | "hazards";

export interface RunRecord {
  kind?: RunKind;
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
        `INSERT INTO runs (kind, started_at, finished_at, fetched, new_items, alerts, sources, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.kind ?? "news",
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
    db
      .prepare("DELETE FROM settings WHERE key LIKE 'login_failures:%' AND json_extract(value, '$.first') < ?")
      .bind(finished - 86_400_000),
  ]);
}

export async function latestRun(db: D1Database, kind: RunKind = "news"): Promise<RunRecord | null> {
  const row = await db
    .prepare("SELECT * FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1")
    .bind(kind)
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
    kind,
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

interface SiteRow extends Omit<Site, "priority" | "approximate"> {
  priority: number;
  approximate: number;
}

export async function listSites(db: D1Database): Promise<Site[]> {
  const { results } = await db.prepare("SELECT * FROM sites ORDER BY name").all<SiteRow>();
  return results.map((row) => ({ ...row, priority: row.priority === 1, approximate: row.approximate === 1 }));
}

const SITE_COLUMNS = 10;

export async function saveSites(db: D1Database, sites: NewSite[], replace: boolean): Promise<void> {
  const row = `(${placeholders(SITE_COLUMNS)})`;
  const inserts = chunk(sites, Math.floor(MAX_PARAMS / SITE_COLUMNS)).map((group) =>
    db
      .prepare(
        `INSERT INTO sites (name, address, city, country, lat, lon, area, keywords, priority, approximate)
         VALUES ${group.map(() => row).join(", ")}`,
      )
      .bind(
        ...group.flatMap((site) => [
          site.name,
          site.address,
          site.city,
          site.country,
          site.lat,
          site.lon,
          site.area,
          site.keywords,
          site.priority ? 1 : 0,
          site.approximate ? 1 : 0,
        ]),
      ),
  );
  // One batch, so a failed import cannot leave the list half replaced.
  await db.batch([...(replace ? [db.prepare("DELETE FROM sites")] : []), ...inserts]);
}

// Records the NWS lookup for each site: zone codes ('' when outside coverage) and state.
export async function saveSiteZones(
  db: D1Database,
  zones: Array<{ id: number; nwsZones: string; region: string }>,
): Promise<void> {
  if (zones.length === 0) return;
  await db.batch(
    zones.map((zone) =>
      db.prepare("UPDATE sites SET nws_zones = ?, region = ? WHERE id = ?").bind(zone.nwsZones, zone.region, zone.id),
    ),
  );
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// Pushes the expiry of ongoing hazards that are still being reported.
export async function extendExpiry(db: D1Database, items: HazardItem[]): Promise<void> {
  const ongoing = items.filter((item) => item.ongoing && item.expiresAt);
  if (ongoing.length === 0) return;
  await db.batch(
    ongoing.map((item) =>
      db
        .prepare("UPDATE items SET expires_at = ? WHERE id = ? AND status != 'expired' AND (expires_at IS NULL OR expires_at < ?)")
        .bind(item.expiresAt, item.id, item.expiresAt),
    ),
  );
}

// Closes alerts whose hazard has lapsed. Returns how many were closed.
export async function expireAlerts(db: D1Database, now: string): Promise<number> {
  const result = await db
    .prepare("UPDATE items SET status = 'expired' WHERE status IN ('new', 'acknowledged') AND expires_at IS NOT NULL AND expires_at < ?")
    .bind(now)
    .run();
  return result.meta.changes;
}

export interface BriefInput {
  incident: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  site: string;
  distanceMi: number | null;
  place: string;
  summary: string;
  reports: number;
  latest: string;
}

// The last day's alerts, one row per incident (or per alert when it has no
// incident), most severe first.
export async function briefInput(db: D1Database, since: string, limit: number): Promise<BriefInput[]> {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(NULLIF(incident, ''), id) AS key, incident, title, category, severity, status, site,
              distance_mi, place, summary, first_seen_at,
              ${SEVERITY_ORDER} AS rank
       FROM items
       WHERE category != 'none' AND status != 'dismissed' AND first_seen_at >= ?
       ORDER BY rank DESC, first_seen_at DESC`,
    )
    .bind(since)
    .all<{
      key: string;
      incident: string;
      title: string;
      category: string;
      severity: string;
      status: string;
      site: string;
      distance_mi: number | null;
      place: string;
      summary: string;
      first_seen_at: string;
    }>();
  const groups = new Map<string, BriefInput>();
  for (const row of results) {
    const group = groups.get(row.key);
    if (group) {
      group.reports++;
      if (row.first_seen_at > group.latest) group.latest = row.first_seen_at;
      continue;
    }
    groups.set(row.key, {
      incident: row.incident,
      title: row.title,
      category: row.category,
      severity: row.severity,
      status: row.status,
      site: row.site,
      distanceMi: row.distance_mi,
      place: row.place,
      summary: row.summary,
      reports: 1,
      latest: row.first_seen_at,
    });
  }
  return [...groups.values()].slice(0, limit);
}

export interface StoredBrief {
  id: number;
  createdAt: string;
  periodStart: string;
  body: unknown;
}

export async function saveBrief(db: D1Database, createdAt: string, periodStart: string, body: unknown): Promise<number> {
  const result = await db
    .prepare("INSERT INTO briefs (created_at, period_start, body) VALUES (?, ?, ?)")
    .bind(createdAt, periodStart, JSON.stringify(body))
    .run();
  return Number(result.meta.last_row_id);
}

export async function latestBrief(db: D1Database): Promise<StoredBrief | null> {
  const row = await db
    .prepare("SELECT * FROM briefs ORDER BY id DESC LIMIT 1")
    .first<{ id: number; created_at: string; period_start: string; body: string }>();
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, periodStart: row.period_start, body: JSON.parse(row.body) };
}
