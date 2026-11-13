-- Hazard alerts lapse on their own (a weather warning ends, a fire is put out).
ALTER TABLE items ADD COLUMN expires_at TEXT;

-- 'news' for the news and social check, 'hazards' for the hazard check.
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'news';

-- National Weather Service zone and county codes covering the site, looked up
-- once: NULL means not looked up yet, '' means the site is outside NWS coverage.
ALTER TABLE sites ADD COLUMN nws_zones TEXT;
-- US state code, filled in by the same lookup.
ALTER TABLE sites ADD COLUMN region TEXT NOT NULL DEFAULT '';

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  -- JSON: the brief as written by the model
  body TEXT NOT NULL
);
