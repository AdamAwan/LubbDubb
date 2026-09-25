export const EJECTIONS_SCHEMA = `
-- An operator taking a running agent's work into their own Claude Code. The row is
-- the hold: while it stands unsettled it keeps the origin off the dispatcher and
-- keeps the worktree slot out of the pool, neither of which survives the agent's
-- own task settling. last_seen_at null means nobody has contacted the harness about
-- this claim at all, which is not the same as a stale timestamp.
CREATE TABLE IF NOT EXISTS ejections (
  id            TEXT PRIMARY KEY,
  origin_ref    TEXT NOT NULL,
  branch        TEXT,
  worktree_path TEXT,
  agent_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  session_id    TEXT,
  reason        TEXT NOT NULL,
  ejected_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  last_note     TEXT,
  settled_at    TEXT,
  outcome       TEXT,
  settle_note   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ejections_live ON ejections(origin_ref) WHERE settled_at IS NULL;
`;
