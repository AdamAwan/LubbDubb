export const PR_DESCRIPTIONS_SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_pr_descriptions_origin ON pr_descriptions(origin_ref);

CREATE INDEX IF NOT EXISTS idx_pr_description_findings_desc ON pr_description_findings(description_id);
`;
