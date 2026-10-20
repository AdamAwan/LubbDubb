export const APP_ERROR_TICKETS_SCHEMA = `
-- What the tracker held under an app error key when it was last searched
-- (docs/spec/39-app-errors.md#the-tracker-lock). One row per key, replaced by each
-- search. A cache for the Errors tab, never a lock of its own: every press searches
-- again before it files. status: none | open | closed | unknown.
CREATE TABLE IF NOT EXISTS app_error_tickets (
  error_key  TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  ticket_ref TEXT,
  closed_at  TEXT,
  tickets    INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  checked_at TEXT NOT NULL
);
`;
