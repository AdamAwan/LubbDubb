export const REMOTE_VALIDATION_SCHEMA = `
-- A question about the data one goal's change writes, asked of a real environment's
-- store (see RemoteValidationStore). Per-goal, harness-held and never committed: a
-- query is one goal's question about one change at one moment, where a repository
-- holds what is true across all of them. Merged on the author's own slug, and
-- withdrawn by nobody but an operator. The dry-run columns are what the environment
-- said when the query was last put to it -- the evidence an operator accepts or
-- rejects the query on -- and they are cleared by a re-declaration that changed the
-- text, because a reading is a reading of *that* query.
CREATE TABLE IF NOT EXISTS remote_state_queries (
  goal_ref   TEXT NOT NULL,        -- issue:<n>
  query_id   TEXT NOT NULL,        -- the author's kebab-case slug, and the merge key
  seq        INTEGER NOT NULL,     -- position in the document; display order only
  title      TEXT NOT NULL,
  query      TEXT NOT NULL,
  presence   TEXT NOT NULL,        -- the second query proving the code path runs; zero rows is unknown, never clean
  why        TEXT,
  digest     TEXT NOT NULL,        -- of query + presence together; the half of an approval's key that is the question
  authored   TEXT NOT NULL DEFAULT 'agent', -- 'plan' | 'agent' | 'operator'; an operator's row is neither swept nor overwritten by a replan
  dry_run_environment TEXT,        -- NULL while nothing has been asked
  dry_run_at          TEXT,
  dry_run_verdict     TEXT,        -- 'fires' | 'zero' | 'unknown'
  dry_run_presence    TEXT,        -- the same three, for the presence query
  dry_run_rows        INTEGER,     -- NULL when the query did not answer
  dry_run_detail      TEXT,        -- what the author and the operator are told, in words
  dry_run_sample      TEXT,        -- what it actually returned, as JSON; a query that reads correctly and returns nonsense is caught only here
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (goal_ref, query_id)
);

-- One operator's "I have read this query, and it is safe *here*" (see
-- RemoteValidationStore). Keyed on the digest *and* the environment, deliberately:
-- keyed on the digest alone, the same text accepted against acceptance would arrive
-- pre-approved against production, and consent to a place is not transferable. An
-- unchanged query stays accepted for the environment it was accepted on; an edited
-- one drops its old digest's approvals everywhere and is a new question again.
CREATE TABLE IF NOT EXISTS remote_query_approvals (
  query_digest    TEXT NOT NULL,
  environment     TEXT NOT NULL,
  goal_ref        TEXT NOT NULL,   -- the goal the accepted query was read on; drawn, never keyed on
  query_id        TEXT NOT NULL,
  approved_at     TEXT NOT NULL,
  approved_rows   INTEGER,         -- what the dry run answered when it was accepted
  approved_detail TEXT,
  PRIMARY KEY (query_digest, environment)
);

-- One goal's checks, watches and state queries assembled against one environment,
-- opened by RemoteValidationDesk when the goal's work arrives there (see
-- RemoteValidationStore). Written OR IGNORE: a second arrival re-runs the sheet that
-- exists rather than opening a second one, and a sheet does not expire -- a row
-- records what this goal meant to be true, and intent does not rot.
CREATE TABLE IF NOT EXISTS remote_sheets (
  goal_ref     TEXT NOT NULL,      -- issue:<n>
  environment  TEXT NOT NULL,
  assembled_at TEXT NOT NULL,
  PRIMARY KEY (goal_ref, environment)
);

-- One row of one sheet. blocked_reason is what an operator is told where no reading
-- was taken at all, and awaiting_approval marks the one blocked cause a person can
-- clear from the sheet itself: a query nobody has accepted against this environment.
CREATE TABLE IF NOT EXISTS remote_sheet_rows (
  goal_ref          TEXT NOT NULL,
  environment       TEXT NOT NULL,
  row_id            TEXT NOT NULL,   -- 'check:<id>' | 'state:<id>' | 'watch:<id>'
  kind              TEXT NOT NULL,   -- 'check' | 'state' | 'signal' | 'measure'
  seq               INTEGER NOT NULL,
  title             TEXT NOT NULL,
  source_id         TEXT NOT NULL,   -- the check, query or watch this row stands for
  selected          INTEGER NOT NULL DEFAULT 1,
  blocked_reason    TEXT,
  awaiting_approval INTEGER NOT NULL DEFAULT 0,
  matched           INTEGER,         -- tests the run's listing attributes to this row's area
  idle_reason       TEXT,            -- why a press reads nothing here; NULL is a row a press reads
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (goal_ref, environment, row_id)
);

-- What a row came back as. Append-only: a later reading supersedes rather than
-- deletes, so the reading a person acted on stays readable. run_id is NULL for a
-- reading taken at assembly, which is every reading until the press lands. These are
-- never WorldEvents and never watch_readings: a world event matching the goal's issue
-- ref expires its standing delivery verdict, and a point-in-time read folded into the
-- watch's table would move a settled verdict on the window's clock.
CREATE TABLE IF NOT EXISTS remote_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_ref    TEXT NOT NULL,
  environment TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  run_id      TEXT,
  outcome     TEXT NOT NULL,   -- 'passed' | 'failed' | 'blocked' | 'captured'
  rows        INTEGER,
  value       REAL,
  detail      TEXT,
  capture     TEXT,            -- file name of the screen this row handed back; NULL is no screen
  read_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS remote_readings_row ON remote_readings (goal_ref, environment, row_id);

-- One row per (run, row) whose capture has been posted to the goal's ticket. The
-- record IS the idempotence: a capture posted twice on a re-read is worse than one
-- never posted, and nothing about the comment itself can be read back to find out
-- whether it went. Like an arrival's announcement, a posting is never a WorldEvent.
-- (see docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at)
CREATE TABLE IF NOT EXISTS remote_capture_posts (
  run_id    TEXT NOT NULL,
  row_id    TEXT NOT NULL,
  goal_ref  TEXT NOT NULL,
  capture   TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, row_id)
);

-- One press (see RemoteValidationStore). Kept after it ends, local_validations' rule:
-- a run abandoned because the environment went back past the goal's work is the case
-- an operator actually hits, and its reason has to be readable afterwards. The
-- mutual exclusion is a conditional insert inside the transaction with this partial
-- index behind it: keyed on the environment alone, two operators validating one
-- environment against two tenants would overwrite each other's readings -- a silent
-- wrong answer rather than a visible clash.
CREATE TABLE IF NOT EXISTS remote_runs (
  id          TEXT PRIMARY KEY,
  goal_ref    TEXT NOT NULL,      -- issue:<n>
  environment TEXT NOT NULL,
  tenant      TEXT NOT NULL,      -- the tenant's *key*; never a tenantEnv's value, and '' where no shape supplies one
  status      TEXT NOT NULL,      -- pending | dispatched | ended | abandoned; the first two are live
  started_sha TEXT,               -- what the environment's at said when the pin was taken
  ended_sha   TEXT,               -- and what it said when the run finished
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  note        TEXT,               -- why an abandoned run was abandoned, in the sheet's own words
  task_id     TEXT,               -- the dispatched agent's task, written by the conditional flip that claimed it
  report_path TEXT,               -- where the agent said the runner's machine-readable report landed
  artefacts   TEXT                -- the URL the publish command printed, where it ran
);

-- The lock is over both live statuses. The old index named only 'running', which this
-- vocabulary no longer holds -- IF NOT EXISTS never re-predicates an index that is
-- already there, so the stale name is dropped by name before the new one is declared.
DROP INDEX IF EXISTS remote_runs_live;

CREATE UNIQUE INDEX IF NOT EXISTS remote_runs_open ON remote_runs (environment, tenant)
  WHERE status IN ('pending', 'dispatched');

-- When an environment's tenant was last provisioned and last reseeded (see
-- RemoteValidationStore). A persistent tenant accumulates the residue of every
-- previous run, and a red row that is not the code's fault is worse than no row --
-- so the age is drawn at the gate, which is where an operator can act on it. The
-- name is always the project's own: the harness generates or infers no tenant
-- identifier anywhere.
CREATE TABLE IF NOT EXISTS remote_tenants (
  environment TEXT NOT NULL,
  tenant      TEXT NOT NULL,
  ensured_at  TEXT,
  reseeded_at TEXT,
  PRIMARY KEY (environment, tenant)
);

-- One row per environment: the tenant preparation running right now, or the last one
-- that ran. Keyed on the environment alone and not on the tenant, because an
-- ensureTenant environment has no tenant name until its own command answers -- the
-- harness invents none while it waits. The commands run for tens of minutes, so an
-- operator who pressed and saw nothing has no way to tell a job still running from one
-- that died; finished_at null is *still running*, and a preparation whose command is
-- gone after a restart is closed saying so, never left in flight for ever.
CREATE TABLE IF NOT EXISTS remote_tenant_prepares (
  environment TEXT PRIMARY KEY,
  tenant      TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  detail      TEXT,
  -- The command running now (ensure | reseed), the harness-owned directory its output
  -- is teed into, and the runner holding it. A restart that finds the runner still
  -- beating keeps the row open and follows it; only a runner that is gone and left no
  -- outcome closes the row as not knowable from here.
  call        TEXT,
  launch_id   TEXT,
  pid         INTEGER,
  launched_at TEXT
);
`;
