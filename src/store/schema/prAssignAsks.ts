export const PR_ASSIGN_ASKS_SCHEMA = `
-- The operator's answer to "want to assign this to someone?", one row per pull
-- request (see PrAssignAskStore). The answer is the whole of what keeps the ask
-- from coming back: a "nah" is as final as a name.
CREATE TABLE IF NOT EXISTS pr_assign_asks (
  pr_number   INTEGER PRIMARY KEY,
  answer      TEXT NOT NULL,
  person_id   TEXT,
  person_name TEXT,
  answered_at TEXT NOT NULL
);
`;
