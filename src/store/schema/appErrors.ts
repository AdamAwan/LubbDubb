export const APP_ERRORS_SCHEMA = `
-- What one environment's own errors command last said (docs/spec/39-app-errors.md).
-- One row per environment, replaced each read. ok_at is the last read that answered,
-- which bounds the next read's {since}. The deploy a read is held against is the
-- environment's head (environment_heads), not a column here.
CREATE TABLE IF NOT EXISTS app_error_reads (
  environment  TEXT PRIMARY KEY,
  status       TEXT NOT NULL,      -- ok | unknown
  detail       TEXT,
  read_at      TEXT NOT NULL,
  ok_at        TEXT
);

-- One error fingerprint on one environment, accumulated across reads. Never a
-- WorldEvent: deliveryHold expires a delivery verdict on any world event.
CREATE TABLE IF NOT EXISTS app_error_groups (
  environment TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title       TEXT NOT NULL,
  operation   TEXT,
  version     TEXT,
  frames      TEXT NOT NULL,       -- JSON list
  url         TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  returned_at TEXT,
  message     TEXT,                -- last, so the hot columns sit before a stack's overflow pages
  stack       TEXT,
  PRIMARY KEY (environment, fingerprint)
);

-- How many times a group happened on each UTC day, for the last fortnight.
CREATE TABLE IF NOT EXISTS app_error_days (
  environment TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  day         TEXT NOT NULL,       -- YYYY-MM-DD
  count       INTEGER NOT NULL,
  PRIMARY KEY (environment, fingerprint, day)
);
`;
