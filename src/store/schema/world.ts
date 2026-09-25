export const WORLD_SCHEMA = `
-- The FakeConnector persists its editable world here so injected events survive restarts.
CREATE TABLE IF NOT EXISTS connector_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Observed world state transitions, diffed from consecutive snapshots. The
-- activity feed's backing store — the world counterpart to the decision log.
CREATE TABLE IF NOT EXISTS world_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Single-row cache of the last snapshot the harness diffed against, so a restart
-- neither blinds the diff nor floods the feed with a spurious "everything new".
CREATE TABLE IF NOT EXISTS world_baseline (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  world TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
`;
