export const ERRORS_SCHEMA = `
-- Recorded failures (cycle exceptions, provider outages, agent crashes, route
-- 500s) — the Errors panel's backing store. See src/errorLog.ts.
CREATE TABLE IF NOT EXISTS error_events (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
`;
