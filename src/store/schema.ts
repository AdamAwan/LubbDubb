/** SQL schema for the LubbDubb store. Applied idempotently on boot. */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  branch      TEXT,
  origin_ref  TEXT,
  status      TEXT NOT NULL,
  agent_id    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
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
  ended_at       TEXT
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

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
`;
