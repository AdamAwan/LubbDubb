export const UPGRADES_SCHEMA = `
-- A deliberate upgrade of the harness's own build: one row, id 1. Persisted where
-- the pause flag beside it is not, because its point is to be read by the process
-- *after* the one that wrote it: the "applying" state tells the next boot that the
-- agents it finds interrupted were interrupted on purpose, and that their recovery
-- verdict has already been decided. See src/store/upgrades.ts.
CREATE TABLE IF NOT EXISTS upgrade_intent (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  state           TEXT NOT NULL,
  target_sha      TEXT,
  requested_at    TEXT,
  paused_by_drain INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);
`;
