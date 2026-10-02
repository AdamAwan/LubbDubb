export const REMOTE_INTENTS_SCHEMA = `
-- An operator's OK to run one goal's sheet on one environment (see RemoteIntentStore).
-- One row per (goal, environment), replaced by the next OK. The desk presses a 'given'
-- intent when its lock is free and marks it 'consumed' with the run it opened; a
-- fingerprint that has moved since the OK is not pressed. Ship day writes a 'consumed'
-- row for every sheet that already existed, on the boot that creates this table only.
CREATE TABLE IF NOT EXISTS remote_run_intents (
  goal_ref    TEXT NOT NULL,      -- issue:<n>
  environment TEXT NOT NULL,
  state       TEXT NOT NULL,      -- given | withdrawn | consumed | not_here
  fingerprint TEXT NOT NULL,      -- what the OK was given over; '' on a ship-day row
  given_at    TEXT NOT NULL,
  run_id      TEXT,               -- the run a consumed intent opened
  note        TEXT,               -- why a given intent waits, in the sheet's words; the operator's own on not_here
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (goal_ref, environment)
);
`;
