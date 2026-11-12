export const WATCHES_SCHEMA = `
-- What a goal's plan declared a running system would have to show for its work to
-- have done what it claimed (see WatchStore). One row per declared check, merged
-- on the author's own slug; the dry-run columns are what the environment said the
-- first time the query was put to it, and they are cleared by a re-declaration
-- because a reading is a reading of *that* query.
CREATE TABLE IF NOT EXISTS goal_watches (
  goal_ref   TEXT NOT NULL,        -- issue:<n>
  check_id   TEXT NOT NULL,        -- the author's kebab-case slug, and the merge key
  seq        INTEGER NOT NULL,     -- position in the document; display order only
  kind       TEXT NOT NULL,        -- 'signal' | 'measure'
  title      TEXT NOT NULL,
  query      TEXT NOT NULL,
  presence   TEXT,                 -- the second query proving the code path runs; required for a signal
  tolerate   INTEGER NOT NULL,     -- the count a signal must not exceed
  expect_under    REAL,            -- a measure's ceiling, or NULL
  expect_over     REAL,            -- a measure's floor, or NULL
  expect_baseline INTEGER NOT NULL DEFAULT 0,  -- 1 where the measure declared noWorseThan: "baseline"
  unit            TEXT,            -- what the number is in; drawn, never parsed
  baseline_value  REAL,            -- the *before*, taken at declaration. NULL means never taken.
  baseline_at     TEXT,
  live            INTEGER NOT NULL DEFAULT 1,  -- 0 while the assessor's set awaits the operator's accept
  proposal        TEXT,            -- retired with watch_declare and read by nothing; left in place, never dropped
  authored        TEXT NOT NULL DEFAULT 'plan', -- 'plan' | 'operator' | 'assessor'; an operator's row is neither swept nor overwritten by a replan
  changed_from_hint TEXT,          -- the assessor's account of where this check departs from the plan's hint; NULL where it says none
  why        TEXT,
  source     TEXT,                 -- the environment watch source it reads, by name; NULL reads the environment's only one
  dry_run_environment TEXT,        -- NULL while nothing has been asked
  dry_run_at          TEXT,
  dry_run_verdict     TEXT,        -- 'fires' | 'zero' | 'unknown'
  dry_run_presence    TEXT,        -- the same three, for the presence query
  dry_run_rows        INTEGER,     -- NULL when the observation did not answer
  dry_run_detail      TEXT,        -- what the author is told, in words
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (goal_ref, check_id)
);

-- One goal's whole work confirmed in one environment, and the period the harness
-- spends asking that environment what happened next (see WatchStore). Opened on an
-- arrival and never on a merge: between the two sit a release train and an approval
-- gate, so a window opened at merge would spend itself asking about code that is
-- not running yet. OR IGNORE on the write -- a goal that arrives again has not
-- opened a second window.
--
-- settled_at NULL means *still watching*, which is a null that means something: a
-- column added to this table later without a backfill gated on ensureColumns'
-- report would reopen every settled window on the boot an operator takes the build.
CREATE TABLE IF NOT EXISTS watch_windows (
  goal_ref    TEXT NOT NULL,        -- issue:<n>
  environment TEXT NOT NULL,
  opened_at   TEXT NOT NULL,        -- the arrival that opened it
  settles_at  TEXT NOT NULL,        -- opened_at + the environment's forMs
  settled_at  TEXT,                 -- NULL while it is still watching
  extended_at TEXT,                 -- when an operator last extended it; NULL means never extended
  exposed_at  TEXT,                 -- when the rollout first cleared watch.exposure.atLeast; NULL before, or none declared
  PRIMARY KEY (goal_ref, environment)
);

-- What one check answered on one reading, in one window (see WatchStore).
-- Append-only, so the card draws the newest and the window keeps the account of
-- what production said. Its own table rather than a WorldEvent, deliberately:
-- deliveryHold expires a standing delivery verdict on *any* world event matching
-- the goal's issue ref, so a reading written as one would un-park the goal it just
-- reported on and hand finished work back to the fleet.
CREATE TABLE IF NOT EXISTS watch_readings (
  goal_ref    TEXT NOT NULL,        -- issue:<n>
  environment TEXT NOT NULL,
  check_id    TEXT NOT NULL,        -- the author's own slug, and the declaration's merge key
  read_at     TEXT NOT NULL,
  verdict     TEXT NOT NULL,        -- 'clean' | 'regressed' | 'unknown'
  rows_read   INTEGER,              -- NULL when the observation did not answer
  value       REAL,                 -- a measure's *now*; NULL for a signal and for anything that did not answer
  detail      TEXT,                 -- why, in words, for anything but a clean one
  PRIMARY KEY (goal_ref, environment, check_id, read_at)
);

-- A goal's post-deploy watch as the assessor wrote it with watch_plan, and what the
-- operator did with it (see WatchStore). validation_plans' shape, one subsystem over.
-- A row is written owed (authored_at NULL) when the assessor's delivered verdict is
-- recorded; no row means the watch was never asked for, which is every goal from before.
CREATE TABLE IF NOT EXISTS watch_plans (
  goal_ref        TEXT PRIMARY KEY,   -- issue:<n>
  authored_at     TEXT,               -- NULL is owed: never written, or sent back
  note            TEXT,               -- where the checks departed from the plan's hint, and why
  empty_reason    TEXT,               -- why nothing was declared; NULL where checks were
  accepted_at     TEXT,               -- NULL on an authored watch is a set still proposed
  sent_back_words TEXT,               -- the operator's last send-back, handed to the next author
  updated_at      TEXT NOT NULL
);
`;
