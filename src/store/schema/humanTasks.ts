export const HUMAN_TASKS_SCHEMA = `
-- Work only a person can do (the request_human_task tool, or an operator filing
-- one from the cockpit). Not an escalation: nothing is blocked on an open socket,
-- no agent is parked, and the row outlives every agent and every restart.
--
-- part_id is the only way one of these ever holds work off the fleet, and that is
-- deliberate: a plan part declared expected_kind='human' is backed by exactly one
-- of these rows, and the part is the scheduling node that depends_on and the
-- reconciler's readiness pass already understand. A standalone human task blocks
-- nothing at all.
--
-- agent_id/task_id/origin_ref come from the caller's credential, never from an
-- argument; all three are null for an operator-filed task, which is how the two
-- arms are told apart without a requested_by column that could disagree with them.
CREATE TABLE IF NOT EXISTS human_tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,        -- the ask, one line (validation refuses a newline)
  detail      TEXT,                 -- what to do and how to know it is done, markdown
  origin_ref  TEXT,                 -- the work it belongs to ("issue:12", "issue:12:part:schema")
  part_id     TEXT,                 -- the plan part this task *is*, when a planner declared one
  kind        TEXT NOT NULL DEFAULT 'ask', -- ask | close_out (the harness's own, which it also settles)
  agent_id    TEXT,                 -- the requesting agent, or null when an operator filed it
  task_id     TEXT,
  status      TEXT NOT NULL,        -- open | done | declined
  resolution  TEXT,                 -- the operator's note; required on declined
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT,
  dismissed_at TEXT       -- when the operator cleared the settled row off the bench; never set while open
);

CREATE INDEX IF NOT EXISTS idx_human_tasks_status ON human_tasks(status);

CREATE INDEX IF NOT EXISTS idx_human_tasks_part ON human_tasks(part_id);
`;
