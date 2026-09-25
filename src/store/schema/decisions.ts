export const DECISIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  cycle_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  detail     TEXT NOT NULL,
  -- The dispatcher rule that *proposed* the action (see src/dispatcher/rules.ts);
  -- NULL when the decision has no rule identity (bookkeeping, human-authorized acts).
  rule       TEXT,
  -- What *became* of that proposal: an admission-kind id from the same registry
  -- (branch-notify, cooldown-escalate), NULL when the proposal was admitted
  -- unchanged. Rows written before this column existed carry the outcome in
  -- rule and NULL here; the two shapes coexist and are told apart by whether
  -- this is set (see Store.migrate).
  admission  TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
`;
