export const APP_ERROR_TRIAGE_SCHEMA = `
-- One batch of moved, unlinked app error groups put in front of one read-only
-- triage agent (docs/spec/39-app-errors.md#agent-triage). Opened by
-- AppErrorTriageDesk, automatically or on an operator's Triage press; claimed by
-- the dispatch that starts its agent, and settled once that agent's task is no
-- longer active. The briefing is assembled once, when the run opens.
CREATE TABLE IF NOT EXISTS app_error_triage_runs (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,        -- 'pending' | 'dispatched' | 'done'
  trigger     TEXT NOT NULL,        -- 'auto' | 'operator'
  subjects    TEXT NOT NULL,        -- JSON [{key, environment, fingerprint, state, anchor, candidates}]
  briefing    TEXT NOT NULL,
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  settled_at  TEXT
);

-- At most one run open at a time: the lock is the index, across a restart.
CREATE UNIQUE INDEX IF NOT EXISTS app_error_triage_runs_open
  ON app_error_triage_runs ((1)) WHERE status IN ('pending', 'dispatched');

-- One verdict per episode: a group, the state it moved into and the instant that
-- episode is anchored at ('' for a spike with no deploy on record). A group that
-- returns again is a new episode and is triaged again.
CREATE TABLE IF NOT EXISTS app_error_triages (
  environment TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state       TEXT NOT NULL,
  anchor      TEXT NOT NULL,
  error_key   TEXT NOT NULL,
  verdict     TEXT NOT NULL,        -- 'caused-by' | 'pre-existing' | 'unclear'
  goal_ref    TEXT,
  confidence  TEXT NOT NULL,        -- 'low' | 'medium' | 'high'
  reason      TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (environment, fingerprint, state, anchor)
);

-- Every time a triage agent asked for a group's stored message and stack: the
-- only way either reaches a model, so every one is recorded and drawn.
CREATE TABLE IF NOT EXISTS app_error_detail_reads (
  error_key   TEXT NOT NULL,
  environment TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state       TEXT NOT NULL,
  anchor      TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_error_detail_reads_episode
  ON app_error_detail_reads (environment, fingerprint, state, anchor);
`;
