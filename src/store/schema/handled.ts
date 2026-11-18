export const HANDLED_SCHEMA = `
-- Small asks the harness answered itself, one row per action, kept so each can be
-- shown afterwards and put back. → docs/spec/43-handled-for-you.md
CREATE TABLE IF NOT EXISTS handled_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  before_value TEXT,
  after_value  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handled_actions_created ON handled_actions (created_at);
`;
