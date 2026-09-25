export const AGENTS_SCHEMA = `
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
  num_turns      INTEGER,
  -- The agent's own one-line answer to "what are you doing right now" (the
  -- note_progress tool). A *current value*, overwritten on each call, not a
  -- stream: the audit trail already exists in the transcript, where every call
  -- appears as a tool use. What did not exist is a cheap current reading, so
  -- that is the only thing stored. noted_at dates the note for display and is
  -- deliberately never read as evidence the agent is alive — see src/mcp/progress.ts.
  note           TEXT,
  noted_at       TEXT,
  -- When this agent was last observed doing work *after* it parked on a human
  -- (issue: stale "needs you" alerts). An observation about the park, not a
  -- status: the escalate tool returns immediately and only *asks* the agent to
  -- wait, so a model that carries on leaves the row saying waiting while it is
  -- plainly working. Deliberately does not un-park -- see AgentManager.noteResumed.
  resumed_at     TEXT,
  -- How many times the harness has re-attached to this agent after its process
  -- died mid-run (issue #318). A budget, not an observation: it bounds the
  -- automatic resume so a claude that dies on every launch settles as failed
  -- instead of relaunching forever. On the row rather than in memory because
  -- spawn/resume reuse one row across restarts, and an in-memory counter would
  -- refill on every boot. Distinct from resumed_at above, which is about a park
  -- and is cleared whenever one is answered.
  resume_attempts INTEGER
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

CREATE INDEX IF NOT EXISTS idx_agent_flags_agent ON agent_flags(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);
`;
