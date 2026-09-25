export const GOAL_CRITERIA_SCHEMA = `
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

-- obstacle_conditions needs no index of its own: every read of it is by
-- obstacle_id, which is the leading column of the UNIQUE above.
CREATE INDEX IF NOT EXISTS idx_goal_criteria_origin ON goal_criteria(origin_ref);

CREATE INDEX IF NOT EXISTS idx_goal_criteria_drift_origin ON goal_criteria_drift(origin_ref);
`;
