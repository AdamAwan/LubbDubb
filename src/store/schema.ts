/** SQL schema for the LubbDubb store. Applied idempotently on boot. */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  branch      TEXT,
  origin_ref  TEXT,
  origin_title    TEXT,
  origin_summary  TEXT,
  dispatch_reason TEXT,
  status      TEXT NOT NULL,
  agent_id    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Operator-launched jobs: prompts queued from the cockpit that the dispatcher
-- drains (ahead of world-driven rules) into agents. A durable queue that lets a
-- manual request wait for a free slot when the fleet is at capacity.
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  branch     TEXT,
  status     TEXT NOT NULL,
  task_id    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  status         TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  pid            INTEGER,
  waiting_reason TEXT,
  -- Claude Code session id, chosen up front so the agent can be resumed
  -- (claude --resume <id>) in its original worktree after a server restart.
  session_id     TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  -- Cumulative Claude usage from the stream runtime's result events (issue #60).
  -- Null for runtimes that report none (PTY).
  cost_usd       REAL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  num_turns      INTEGER
);

-- Timestamped per-report cost deltas (not cumulative), so account-level rolling
-- usage windows (5h / 7d) are a plain SUM over the window (issue #60).
CREATE TABLE IF NOT EXISTS usage_events (
  agent_id TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  at       TEXT NOT NULL
);

-- Artifacts an agent surfaced to the cockpit mid-run via the flag sentinel
-- (a design doc, a report, a link). Deduped per agent by ref so an evolving doc
-- refreshes in place; created_at tracks the most recent flag of that ref.
CREATE TABLE IF NOT EXISTS agent_flags (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  ref        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, ref)
);

-- Every file an agent wrote, captured by the file-events PostToolUse hook (not
-- the flag sentinel). Deduped per agent by path; the promoted flag marks the ones
-- also surfaced as an artifact chip (a report/doc, per classifyArtifact).
CREATE TABLE IF NOT EXISTS agent_files (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  tool       TEXT,
  promoted   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, path)
);

CREATE TABLE IF NOT EXISTS agent_transcripts (
  agent_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  chunk      TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);

CREATE TABLE IF NOT EXISTS escalations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  context     TEXT NOT NULL,
  agent_id    TEXT,
  task_id     TEXT,
  response    TEXT,
  created_at  TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  cycle_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  detail     TEXT NOT NULL,
  -- The dispatcher rule that produced the action (see src/dispatcher/rules.ts);
  -- NULL when the decision has no rule identity (LLM dispatcher, bookkeeping).
  rule       TEXT,
  created_at TEXT NOT NULL
);

-- The FakeConnector persists its editable world here so injected events survive restarts.
CREATE TABLE IF NOT EXISTS connector_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
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

-- Recorded failures (cycle exceptions, provider outages, agent crashes, route
-- 500s) — the Errors panel's backing store. See src/errorLog.ts.
CREATE TABLE IF NOT EXISTS error_events (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_flags_agent ON agent_flags(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);
CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
`;
