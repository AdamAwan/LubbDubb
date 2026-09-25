export const LOCAL_RUNS_SCHEMA = `
-- The local run (see LocalRunStore): which goal's code is in the machine's one dev
-- environment. One row per run and the row outlives the run, so a start that failed
-- has its reason somewhere to read; the *live* one is whichever row is 'starting' or
-- 'running', and there is only ever one because the writer ends the last before it
-- writes a new one. The table is new, so it needs no ColumnMigrations entry — but
-- a table being new once does not keep it exempt, and a column added later will.
CREATE TABLE IF NOT EXISTS local_runs (
  id         TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,
  ref        TEXT NOT NULL,     -- the git ref the checkout was pointed at
  dir        TEXT NOT NULL,
  -- The commit the checkout stands at: written by the start, rewritten by a refresh.
  -- What the watch measures freshness from, since a ref names a branch and a branch
  -- moves. Null on a row from before the column -- where that checkout stood was
  -- never written down, and the freshness reading says so rather than guessing.
  -- Named commit_sha because COMMIT is a keyword.
  commit_sha TEXT,
  pid        INTEGER,           -- the session whose *subtree* a stop has to reap
  status     TEXT NOT NULL,
  url        TEXT,              -- as configured when the run started, not as it reads now
  note       TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  -- When the harness that was holding this run went down, stamped by the fast stop
  -- on its way out. It is the age a resume is judged on: an environment nobody has
  -- been near for hours is not one to bring back. Null on a row nothing stamped --
  -- a hard crash, where the harness never got a line -- which falls back to
  -- last_seen_at below, and is unknown only if that is null too.
  interrupted_at TEXT,
  -- The last beat on which the harness was holding this run, stamped from the pulse
  -- while a session of this process holds it. What dates a force close: taskkill,
  -- Task Manager, a power cut and a closed console window all take the process
  -- without running a line, so interrupted_at stays null and this is the only record
  -- of when the environment was last true. Stamped only by the process actually
  -- holding the run, so a live row a boot declined to bring back is never dated.
  last_seen_at TEXT
);

-- One dated cost delta per usage report a local run's sessions made -- the sibling
-- of usage_events, and separate from it because that table's agent_id is the join
-- the reliability breakdown prices a pull request's CI through. A row says what a
-- run came to and never when the money went, so a rolling window or a trend can
-- only be read off these.
CREATE TABLE IF NOT EXISTS local_run_cost_deltas (
  local_run_id TEXT NOT NULL,
  cost_usd     REAL NOT NULL,
  at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_run_cost_deltas_at ON local_run_cost_deltas(at);

CREATE INDEX IF NOT EXISTS idx_local_runs_status ON local_runs(status);
`;
