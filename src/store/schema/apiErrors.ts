export const API_ERRORS_SCHEMA = `
-- One row per agent turn the model API refused ("API Error: ..."), read off the
-- stream transport's result event (docs/spec/18-observability.md#api-errors).
-- kind is 'safeguards' for a usage-policy flag, 'other' for anything else; code is
-- the bracketed Details tag, e.g. reasoning_extraction.
CREATE TABLE IF NOT EXISTS api_errors (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  origin_ref TEXT,
  model      TEXT,
  kind       TEXT NOT NULL,
  code       TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_errors_created ON api_errors(created_at);
`;
