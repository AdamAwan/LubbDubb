export const ESCALATIONS_SCHEMA = `
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

-- Acts a human was asked to authorize, and what they said (issue #109). A *fresh*
-- table rather than columns on escalations, for two reasons that outlast the
-- migration cost: an escalation is answered once with free text and is done,
-- whereas a proposal carries a typed verdict a rule reads on every pulse — and
-- the gate keys on ref, which is a column only a proposal has. Widening
-- escalations would have given every existing question five permanently-null
-- decision columns and no way to tell "not a proposal" from "not yet decided".
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,      -- reply_draft | merge
  ref           TEXT NOT NULL,      -- "pr:42:merge" — the act's subject, what the gate keys on
  status        TEXT NOT NULL,      -- pending | accepted | rejected | withdrawn
  action        TEXT NOT NULL,      -- JSON: the validated action, run verbatim on accept
  note          TEXT,
  decided_by    TEXT,               -- human | stack_landing (| auto_send, historical)
  decided_at    TEXT,
  escalation_id TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_ref ON proposals(ref);
`;
