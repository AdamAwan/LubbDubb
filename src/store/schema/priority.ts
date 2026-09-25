export const PRIORITY_SCHEMA = `
-- Operator priority overrides for the "Up next" queue (issue #128). One row per
-- overridden candidate origin; rank (ascending, 0 = "do this next") re-orders
-- the dispatcher's ranking. Keyed on the stable origin so it survives pulses and
-- restarts even though the queue is a per-pulse projection. last_seen_at is
-- bumped each pulse the origin is still tracked, so an override for work the
-- harness has stopped tracking is pruned rather than lingering forever.
CREATE TABLE IF NOT EXISTS priority_overrides (
  origin       TEXT PRIMARY KEY,
  rank         INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_priorities (
  origin     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;
