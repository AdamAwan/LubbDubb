export const PREDICTION_SCHEMA = `-- An operator's prediction about a goal, written before they first read its plan.
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

-- A goal's human-authored acceptance criteria, append-only and versioned. An edit
-- is a new row pointing at the one it supersedes; no UPDATE ever touches criteria
-- text. The standing (pre-reveal / post-reveal / post-work) is *derived* against
-- goal_reveals and the first part dispatch and is deliberately not stored: a flag
-- is a claim that can be written wrongly once and is then true forever.
--
-- Unlike a prediction, criteria are an oracle the implementer is meant to be judged
-- against, so they are not contained the way a prediction is (handing them to an
-- agent is not built yet). The two share a moment and a table
-- neighbourhood; they do not share a containment rule.
CREATE TABLE IF NOT EXISTS goal_criteria (
  id          TEXT PRIMARY KEY,
  origin_ref  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  supersedes  TEXT,
  text        TEXT NOT NULL,
  author      TEXT,
  reason      TEXT,               -- required when the standing is post-work
  authored_at TEXT NOT NULL,
  UNIQUE (origin_ref, version)
);

-- The alignment check's reading of one criteria version against the ticket's own
-- criteria. Keyed on the version it read, so a revision is a new question.
CREATE TABLE IF NOT EXISTS goal_criteria_alignments (
  id            TEXT PRIMARY KEY,
  origin_ref    TEXT NOT NULL,
  version       INTEGER NOT NULL,
  criteria_id   TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  points        TEXT NOT NULL,      -- JSON: CriteriaAlignmentPoint[]
  agent_id      TEXT,
  decided_at    TEXT NOT NULL,
  pressed_on_at TEXT,
  UNIQUE (origin_ref, version)
);

CREATE TABLE IF NOT EXISTS goal_criteria_drift (
  id          TEXT PRIMARY KEY,
  origin_ref  TEXT NOT NULL,
  criteria_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  author      TEXT,
  reason      TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (criteria_id)
);

-- One part's pull-request description, as the operator wrote it.
-- Append-only for goal_criteria's reason: what shipped on a
-- pull request stays readable after the operator has rewritten it. origin_ref is
-- the *part's* origin, because one part is one pull request.
--
-- The four mark columns are the desktop session's reading written onto the version
-- it read, null where it did not reach that question. They are columns rather than
-- a table of their own because a check answers a version once: a second check is a
-- second read of the same text, and the row it lands on is the one it read.
CREATE TABLE IF NOT EXISTS pr_descriptions (
  id                TEXT PRIMARY KEY,
  origin_ref        TEXT NOT NULL,
  version           INTEGER NOT NULL,
  supersedes        TEXT,
  text              TEXT NOT NULL,
  author            TEXT,
  authored_at       TEXT NOT NULL,
  checked_at        TEXT,
  UNIQUE (origin_ref, version)
);

-- What one check found, one row each. A table rather than columns on the version
-- because a check is not four answers: the four questions under the field are hints,
-- and a record keyed by them can only ever report on four things, while most of what
-- is worth saying about a description against its diff is none of them. A finding
-- names a question only where it happens to be one.
CREATE TABLE IF NOT EXISTS pr_description_findings (
  id             TEXT PRIMARY KEY,
  description_id TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL,   -- contradicted | gap
  note           TEXT NOT NULL,
  question       TEXT,            -- an optional tag, never the schema
  UNIQUE (description_id, seq)
);

-- The tail open_pr wrote under one part's pull request: the evidence block and the
-- reference, with nothing of the operator's in front of it. Kept because the
-- description is written *after* the pull request opens, and putting it in front of
-- that tail is the whole of the edit — the alternative is reading the body back off
-- the provider, which is a second source of truth for a string the harness composed.
CREATE TABLE IF NOT EXISTS pr_description_bodies (
  origin_ref TEXT PRIMARY KEY,
  pr_number  INTEGER NOT NULL,
  tail       TEXT NOT NULL,
  opened_at  TEXT NOT NULL
);

-- The body the agent sent to open_pr: kept, not shipped,
-- until the operator hands it over (handed_at). Where the agent sent none, a hand-over
-- creates the row empty and rule pr-describe writes it. An operator's own version in
-- pr_descriptions outranks it, so it is never pushed over theirs.
CREATE TABLE IF NOT EXISTS pr_description_drafts (
  origin_ref TEXT PRIMARY KEY,
  pr_number  INTEGER NOT NULL,
  text       TEXT,
  written_at TEXT,
  handed_by  TEXT,
  handed_at  TEXT,
  pushed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_remedies_pr ON remedies(pr_number);
CREATE INDEX IF NOT EXISTS idx_human_tasks_status ON human_tasks(status);
CREATE INDEX IF NOT EXISTS idx_human_tasks_part ON human_tasks(part_id);
CREATE INDEX IF NOT EXISTS idx_human_tasks_kind_origin ON human_tasks(kind, origin_ref);
CREATE INDEX IF NOT EXISTS idx_plans_origin ON plans(origin_ref);
CREATE INDEX IF NOT EXISTS idx_plan_parts_plan ON plan_parts(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_atoms_plan ON plan_atoms(plan_id);
CREATE INDEX IF NOT EXISTS idx_validation_checks_goal ON validation_checks(origin_ref);
CREATE INDEX IF NOT EXISTS idx_proposals_ref ON proposals(ref);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);
CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_ref);
CREATE INDEX IF NOT EXISTS idx_issue_bug_filings_origin ON issue_bug_filings(origin_ref);
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_ref);
CREATE INDEX IF NOT EXISTS idx_pet_actions_at ON pet_actions(at);
CREATE INDEX IF NOT EXISTS idx_pet_purchases_pet ON pet_purchases(pet_id);
-- Every reading folds a window, so the date is the only selective column. The
-- second index is the compaction's own: it sweeps by date for rows that still
-- carry arguments, and without it that is a full scan on every boot.
-- Every read of surface_reach is a window fold or the retention sweep, and both
-- cut on the date alone.
CREATE INDEX IF NOT EXISTS idx_surface_reach_at ON surface_reach(at);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_created ON mcp_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_api_errors_created ON api_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_args ON mcp_calls(args_dropped, created_at);
-- Both obstacle reads are by their parent row: the keys an obstacle holds, and the
-- sightings behind it. The key *lookup* goes through the UNIQUE index on value.
CREATE INDEX IF NOT EXISTS idx_obstacle_keys_obstacle ON obstacle_keys(obstacle_id);
CREATE INDEX IF NOT EXISTS idx_obstacle_sightings_obstacle ON obstacle_sightings(obstacle_id);
-- The mid-session desk asks one question per live agent: what has this one already
-- been told? The primary key leads on the obstacle, so that read needs its own.
CREATE INDEX IF NOT EXISTS idx_obstacle_notices_agent ON obstacle_notices(agent_id);
-- A suggestion is read from both ends — the intake answers near[] on the row a
-- report landed on, and the pair may have been proposed the other way round — so
-- the trailing column of the primary key needs its own.
CREATE INDEX IF NOT EXISTS idx_obstacle_suggestions_suggested ON obstacle_suggestions(suggested_id);
-- obstacle_conditions needs no index of its own: every read of it is by
-- obstacle_id, which is the leading column of the UNIQUE above.
CREATE INDEX IF NOT EXISTS idx_goal_criteria_origin ON goal_criteria(origin_ref);
CREATE INDEX IF NOT EXISTS idx_goal_criteria_drift_origin ON goal_criteria_drift(origin_ref);
CREATE INDEX IF NOT EXISTS idx_pr_descriptions_origin ON pr_descriptions(origin_ref);
CREATE INDEX IF NOT EXISTS idx_pr_description_findings_desc ON pr_description_findings(description_id);
`;
