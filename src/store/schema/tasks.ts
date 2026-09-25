export const TASKS_SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_ref);
`;
