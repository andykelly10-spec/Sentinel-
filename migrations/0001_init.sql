CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  -- physical | cyber | brand | executive | unclassified | none
  category TEXT NOT NULL,
  -- low | medium | high | critical
  severity TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  -- new | acknowledged | dismissed
  status TEXT NOT NULL DEFAULT 'new',
  emailed_at TEXT,
  sms_at TEXT
);

CREATE INDEX idx_items_alerts ON items (category, first_seen_at);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  fetched INTEGER NOT NULL,
  new_items INTEGER NOT NULL,
  alerts INTEGER NOT NULL,
  -- JSON: per-source { source, count, error }
  sources TEXT NOT NULL,
  errors TEXT NOT NULL DEFAULT '[]'
);
