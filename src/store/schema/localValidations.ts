export const LOCAL_VALIDATIONS_SCHEMA = `
-- Each time the fleet was asked to drive the machine's dev environment and say
-- whether a goal's changes work (see LocalValidationStore). One row per press of
-- the button, kept after it ends: a validation abandoned because somebody swapped
-- the environment is the case an operator actually hits, and the reason has to be
-- readable afterwards.
--
-- run_id and commit_sha are the *pin*: which environment this reading was planned
-- against. Everything later compares the live run to them, because a report taken
-- after the checkout moved is a reading of code nobody asked about.
CREATE TABLE IF NOT EXISTS local_validations (
  id           TEXT PRIMARY KEY,
  origin_ref   TEXT NOT NULL,       -- the goal, as issue:<n>
  run_id       TEXT NOT NULL,       -- the local_runs row this was requested against
  ref          TEXT NOT NULL,       -- the branch that run had out; what a fix is dispatched onto
  commit_sha   TEXT,                -- named for local_runs' reason: COMMIT is a keyword
  status       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  dispatched_at TEXT,               -- when an agent actually spawned, not when one was proposed
  ended_at     TEXT,
  task_id      TEXT,                -- the validator
  fix_task_id  TEXT,                -- the fix, and the latch that keeps one failure to one fix
  plan         TEXT,                -- markdown, written before the environment was up
  summary      TEXT,
  findings     TEXT NOT NULL,       -- JSON array of LocalValidationFinding
  visited      TEXT NOT NULL,       -- JSON array of URLs the agent opened
  screenshots  TEXT NOT NULL,       -- JSON array of file names in the row's own output directory
  note         TEXT                 -- why it was abandoned, or what a blocked run could not reach
);

CREATE INDEX IF NOT EXISTS idx_local_validations_origin ON local_validations(origin_ref);
`;
