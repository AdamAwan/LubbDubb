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
  live            INTEGER NOT NULL DEFAULT 1,  -- 0 while an agent's declaration awaits the operator
  proposal        TEXT,            -- an agent's pending amendment, as JSON; NULL where none is outstanding
  authored        TEXT NOT NULL DEFAULT 'plan', -- 'plan' | 'operator'; an operator's row is neither swept nor overwritten by a replan
  why        TEXT,
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
`;
