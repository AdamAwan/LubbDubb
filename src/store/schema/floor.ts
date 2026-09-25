export const FLOOR_SCHEMA = `
-- One run of the harness at a goal (issue #234), from the first pulse that saw
-- work under it until the operator dismisses it.
--
-- It replaces floor_completions (#203), which recorded a *completion* and so
-- was minted only for a goal already finished while its issue was still live.
-- Two things were wrong with that. A goal nobody finished — abandoned, or its
-- ticket closed mid-flight — was never recorded at all, so there was nothing to
-- dismiss; and the row retained the *card* while ctx.world.issues still came
-- straight off the tracker, so after a close the harness could draw a goal it
-- could no longer act on. This row is what the dispatcher's issue list is
-- unioned with, so the assessor and the retrospective — both of which come
-- *after* a merge — still run once the ticket is closed.
--
-- The five snapshot columns are the issue as it last stood while live: a
-- retained run is dispatched from, so its body feeds the assessor's and the
-- retro's prompts and its labels feed every watch gate. migrate() backfills
-- this table from floor_completions and drops it — a live database holds
-- dismissals the operator has already made, and losing one resurrects a card
-- they cleared.
CREATE TABLE IF NOT EXISTS issue_runs (
  origin_ref      TEXT PRIMARY KEY,  -- "issue:12"
  issue_number    INTEGER NOT NULL,
  title           TEXT NOT NULL,     -- captured while the issue is still live
  body            TEXT NOT NULL,     -- and so is the rest of the snapshot
  labels          TEXT NOT NULL,     -- JSON array
  linked_pr       INTEGER,
  work_item_state TEXT,
  started_at      TEXT NOT NULL,     -- first pulse with work under this origin; frozen
  completed_at    TEXT,              -- first observed complete; frozen. Null while it is not
  outcome         TEXT,              -- 'judged' | 'abandoned', stamped at dismissal
  dismissed_at    TEXT,              -- null until the operator dismisses; one-way
  updated_at      TEXT NOT NULL
);
`;
