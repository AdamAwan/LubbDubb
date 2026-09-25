export const PREDICTIONS_SCHEMA = `
-- An operator's prediction about a goal, written before they first read its plan.
-- One row per issue:<n> origin at most: parts do not exist when the prediction is
-- made, and *where the decomposition falls* is one of the things a prediction can
-- be wrong about, so the goal is the only grain that can hold it.
--
-- This table is reached through PredictionStore, which is deliberately NOT a member
-- of Store. Nothing handed a Store can name it, which is what keeps the
-- containment invariant a property of the composition root rather than a rule
-- somebody has to remember. → 14-persistence.md#the-prediction-store-is-not-on-store
CREATE TABLE IF NOT EXISTS goal_predictions (
  id         TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL UNIQUE,
  author     TEXT,
  locus      TEXT,
  cause      TEXT,
  split      TEXT,
  avoid      TEXT,
  -- Moment one: how each filled slot stood against the plan it was predicting.
  -- 'matched' | 'missed' | 'not-applicable', and null is not marked yet — a fourth
  -- value that the aggregate counts as nothing, never as a miss. A skipped slot has
  -- nothing to mark and stays null. Named for moment one because delivery asks a
  -- second question of the same slots.
  plan_mark_locus TEXT,
  plan_mark_cause TEXT,
  plan_mark_split TEXT,
  plan_mark_avoid TEXT,
  plan_marked_at  TEXT,
  -- Moment two: whether the plan the fleet produced turned out to be right, per
  -- slot, asked at delivery. Same three values and the same null, which is skipped
  -- or not asked yet and is never a miss. A separate record from moment one's
  -- because the interesting rows are the ones where the two disagree.
  outcome_mark_locus TEXT,
  outcome_mark_cause TEXT,
  outcome_mark_split TEXT,
  outcome_mark_avoid TEXT,
  outcome_marked_at  TEXT,
  -- The prediction judge's reading of moment one, beside the operator's. Written once,
  -- by the one agent that may read a prediction.
  judge_mark_locus TEXT,
  judge_mark_cause TEXT,
  judge_mark_split TEXT,
  judge_mark_avoid TEXT,
  judge_marked_at  TEXT,
  judge_owed       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The reveal gate's answer: this goal's plan was drawn obscured, the operator
-- pressed one of the two, and the plan was handed over.
--
-- The absence of a row is load-bearing and is not a decline. A goal that was never
-- offered the gate — every goal from before the switch was thrown — has no row, for
-- good, and the aggregate reads it as "not offered". Stamping a reveal while the
-- feature is off would hand the operator who turns it on a fabricated backlog of
-- declines in the one week the record has to earn any trust.
CREATE TABLE IF NOT EXISTS goal_reveals (
  origin_ref  TEXT PRIMARY KEY,
  revealed_at TEXT NOT NULL,
  predicted   INTEGER NOT NULL   -- 0/1: whether a prediction existed at the reveal
);
`;
