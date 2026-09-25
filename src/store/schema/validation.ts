export const VALIDATION_SCHEMA = `
-- How anyone checks that the *goal* was met: the executable form of the plan's
-- verification narrative. Per goal rather than per part — a check usually spans
-- parts, and the question it answers is whether the thing works — and keyed on the
-- goal for the same reason, rather than on whichever plan of the work declared it.
--
-- The id is author-chosen and stable, so an amended plan merges onto these rows;
-- the letter is assigned at ingestion and never reused, so the handle a person
-- types names one check for the life of the goal. The result is columns rather
-- than a table: a check has exactly one current reading, and the trail of how it
-- got there is the record beside it.
CREATE TABLE IF NOT EXISTS validation_checks (
  origin_ref  TEXT NOT NULL,          -- the goal, issue:<n> — not the plan; validation is per goal
  id          TEXT NOT NULL,          -- author-chosen kebab-case slug; the merge key
  letter      TEXT NOT NULL,          -- A, B, C… — the handle a person types
  seq         INTEGER NOT NULL,       -- declaration order, for rendering; never the letter
  title       TEXT NOT NULL,
  check_do    TEXT NOT NULL,          -- the procedure, markdown ("do" is a SQLite keyword)
  check_expect TEXT NOT NULL,         -- what a pass looks like
  uses        TEXT NOT NULL,          -- JSON array of resource *names*, never paths
  covers      TEXT NOT NULL,          -- JSON array of part slugs this check exercises
  satisfies   TEXT,                   -- JSON array of goal criteria (their text) this check answers
  fleet_candidate INTEGER NOT NULL DEFAULT 0,  -- the planner's nomination; dispatches nothing
  candidate_why   TEXT,               -- why an agent could run it; kept only with the nomination
  actor       TEXT,                   -- human | fleet — the operator's hand-over; never the planner's
  handback_note TEXT,                 -- why the fleet gave it back; cleared by the next reading
  claimed_by  TEXT,                   -- desktop session holding this check; one live claim harness-wide
  claimed_at  TEXT,                   -- when it was taken; a claim past desktopClaimMinutes holds nothing
  state       TEXT NOT NULL,          -- unrun | passed | failed | waived | deferred | captured. A value
                                      -- on an existing column, so no ALTER TABLE: "captured" is a
                                      -- screen waiting to be looked at, and a row from before it
                                      -- reads "unrun", which is what checkStateOf narrows to
  result_note TEXT,                   -- the one current reading: a result, a deferral's reason, a waiver's
  result_by   TEXT,                   -- operator | agent | desktop | spec | script; null while unrun.
                                      -- "script" is a one-off script's own assertion and is never
                                      -- folded with "spec", which had a reviewer
  result_at   TEXT,
  defer_until TEXT,                   -- when a deferral says it comes back; null is "not saying"
  superseded_reason TEXT,             -- set when an amendment stopped declaring it; null is live
  revision    TEXT,                   -- JSON: the wording an amendment replaced, and the reading it withdrew
  amended_at  TEXT,                   -- when an amendment last changed it; cleared by the next reading
  amend_note  TEXT,                   -- why it changed, in the amender's words
  steps       TEXT,                   -- JSON: the check's test plan, one ordered journey through the
                                      -- delivered goal, each step with the actor read off the
                                      -- configuration. NULL is "no steps", which is every row from
                                      -- before the column and stays true, so nothing is backfilled
  capture     TEXT,                   -- the screen a "screenshot" step handed back: a file NAME in the
                                      -- goal's validation directory, never a path and never an
                                      -- artefact URL. NULL is "no capture", true of every row from
                                      -- before the column, so nothing is backfilled
  proof       TEXT,                   -- what a pass must hand BACK, prose, written by the check's
                                      -- author before the run. NULL is "no evidence was demanded",
                                      -- true of every row from before the column and of every check
                                      -- whose assertion is the whole of its evidence, so nothing is
                                      -- backfilled — and it never folds into "evidence was demanded
                                      -- and none came", which is a blocked row
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (origin_ref, id)
);

-- A goal's validation plan, written in two halves. The plan document writes the
-- hint — prose intent, binding nothing — and the validation planner writes the
-- rest after the goal is delivered, against merged code.
--
-- The authored_at stamp is the fact nothing else holds. An empty check set is a
-- legitimate answer and is indistinguishable from a planner that never ran, so
-- sheet assembly waits on this stamp rather than on a check count: a sheet
-- assembled before the set is authored carries only the watch-derived rows and
-- reads as a misconfiguration.
CREATE TABLE IF NOT EXISTS validation_plans (
  origin_ref   TEXT PRIMARY KEY,      -- the goal, issue:<n>
  hint         TEXT,                  -- the plan's prose intent; null is a plan that declared none
  note         TEXT,                  -- where the planner departed from the hint, and why
  empty_reason TEXT,                  -- why nothing was declared; null where checks were
  authored_at  TEXT,                  -- null is "the check set has not been written yet"
  released_at  TEXT,                  -- null is "authored, and still a proposal an operator has not accepted"
  updated_at   TEXT NOT NULL
);

-- What a check needs that is not in the repository: a seeded fixture, a reference
-- screenshot, an account on an environment. Named rather than pathed — the path
-- an agent sees, the path the cockpit serves and the path an operator opens are
-- three different strings, and a stored absolute one is wrong for two of them the
-- moment the configured validation root moves.
CREATE TABLE IF NOT EXISTS validation_resources (
  origin_ref TEXT NOT NULL,           -- the goal, as above
  name     TEXT NOT NULL,
  kind     TEXT,                      -- fixture | access | reference | data; null = unstated
  note     TEXT,
  provided INTEGER NOT NULL DEFAULT 1, -- 0 is the planner asking for something it cannot produce
  human_task_id TEXT,                 -- the ask filed for an unprovided one, so a replan files it once
  PRIMARY KEY (origin_ref, name)
);

CREATE INDEX IF NOT EXISTS idx_validation_checks_goal ON validation_checks(origin_ref);
`;
