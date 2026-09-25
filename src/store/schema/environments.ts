export const ENVIRONMENTS_SCHEMA = `
-- The commit each of a goal's pull requests landed as (see EnvironmentStore). Stored
-- because it cannot be recovered: a squash merge leaves the branch with no ancestry
-- link to its base, and the provider only offers the merge SHA for as long as the PR
-- stays inside the closed-PR window. Keyed on the pull request, for branch_reaps'
-- reason -- a branch name is reusable, and a goal can land more than once.
CREATE TABLE IF NOT EXISTS goal_landings (
  pr_number      INTEGER PRIMARY KEY,
  goal_ref       TEXT NOT NULL,      -- issue:<n>
  sha            TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  on_integration TEXT                -- yes | no | NULL, meaning not yet asked
);

-- What an environment probe said about one landed commit (see EnvironmentStore).
-- Stored so the cost of the feature is not a process spawn per landing per
-- environment per pulse: a reached verdict is never re-asked, and the rest are.
CREATE TABLE IF NOT EXISTS environment_reach (
  sha         TEXT NOT NULL,
  environment TEXT NOT NULL,
  status      TEXT NOT NULL,      -- reached | absent | unknown
  detail      TEXT,               -- why, for an unknown
  observed_at TEXT NOT NULL,
  PRIMARY KEY (sha, environment)
);

-- A whole goal's work confirmed in one environment, the first time it was (see
-- EnvironmentStore). Stored because an arrival is a *moment* and reach is a
-- status: without a row, the comment goes out every pulse and the signal reads as
-- a state rather than as something that happened.
CREATE TABLE IF NOT EXISTS goal_arrivals (
  goal_ref     TEXT NOT NULL,      -- issue:<n>
  environment  TEXT NOT NULL,
  arrived_at   TEXT NOT NULL,      -- the reading that confirmed the goal's last landing
  recorded_at  TEXT NOT NULL,
  announced_at TEXT,               -- NULL while the announce pass has not seen it
  PRIMARY KEY (goal_ref, environment)
);

-- What one environment's own health check last said (see EnvironmentStore). One
-- row per environment, replaced each reading: health is a status, not a history,
-- and a table growing a row every five minutes per environment would be a log
-- nothing reads. changed_at is kept across a reading that says the same thing, so
-- "red" can be drawn as "red since Tuesday" -- moved by a change of state or tier
-- and not by a change of reasons, since a shifting reason list under one tier is
-- the same episode still running.
CREATE TABLE IF NOT EXISTS environment_health (
  environment TEXT PRIMARY KEY,
  state       TEXT NOT NULL,      -- healthy | unhealthy | unknown
  tier        TEXT,               -- red | orange, for an unhealthy; NULL otherwise
  reasons     TEXT NOT NULL,      -- the check's own sentences, as a JSON list
  detail      TEXT,               -- why, for an unknown the harness refused
  observed_at TEXT NOT NULL,
  changed_at  TEXT NOT NULL       -- when it last became what it is now
);

-- Goals the operator has said are not waiting on an environment: a docs change, a
-- config change, work whose deployment nothing here can see. Lifts every gate on
-- that goal, and is cleared by deleting the row so "not released" has one shape.
CREATE TABLE IF NOT EXISTS environment_gate_releases (
  goal_ref    TEXT PRIMARY KEY,    -- issue:<n>
  note        TEXT NOT NULL,
  released_at TEXT NOT NULL
);
`;
