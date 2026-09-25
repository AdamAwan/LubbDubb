export const SCRATCH_SCHEMA = `
-- The shared per-issue scratchpad: what the agents working one goal leave for
-- whoever works it next, and for the retrospective written at the end.
--
-- Append-only by design. maxConcurrentPartsPerIssue permits concurrent part
-- agents, so a pad shaped as one mutable document would have them overwrite each
-- other with no merge anywhere — the silent loss detectFileOverlaps exists to
-- expose, reintroduced deliberately. Per-agent sections would avoid the clobber and
-- let an agent quietly rewrite its own history, and *when* something was learned is
-- half of what a retrospective is reading for. Attribution is written from the
-- credential, never from an argument (see padOriginFor).
CREATE TABLE IF NOT EXISTS scratch_entries (
  id                TEXT PRIMARY KEY,
  pad_ref           TEXT NOT NULL,    -- "issue:12", or "pr:42" for the agents working a pull request
  author_origin_ref TEXT NOT NULL,    -- "issue:12:part:schema", "pr:42:ci"
  agent_id          TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  topic             TEXT,             -- optional scannable tag
  note              TEXT NOT NULL,
  decision          TEXT,             -- JSON PadDecision on a fork; null on an ordinary note
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scratch_pad ON scratch_entries (pad_ref, created_at);

-- The run's own post-mortem: one document per goal, written after it was
-- delivered. What shipped, and what came out of the process of shipping it.
--
-- A fresh table rather than columns on issue_conclusions, because the two promise
-- different things: a conclusion is a verdict a gate re-reads every pulse, and this
-- is prose nothing branches on. The document lives here rather than being surfaced
-- as an artifact chip for plans.document's reason — GET /artifacts/:id serves out of
-- the writing agent's worktree, which the reap removes, so a write-up surfaced that
-- way 404s exactly when it becomes worth reading.
CREATE TABLE IF NOT EXISTS retrospectives (
  origin_ref TEXT PRIMARY KEY,        -- "issue:12"
  summary    TEXT NOT NULL,           -- the one line an operator reads first
  document   TEXT NOT NULL,           -- markdown, trimmed at write time rather than refused
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
