export const PR_SPLITS_SCHEMA = `
-- One row per pull request rule pr-split has asked about, whatever the answer.
-- The row is what stops it asking twice: a pull request wide enough to be worth a
-- look is worth exactly one look, and a 'coherent' verdict is as much a record as a
-- 'split' one. Keyed on the pull request rather than its head commit, so pushing to
-- a PR already judged coherent does not buy another assessment.
CREATE TABLE IF NOT EXISTS pr_splits (
  pr_number    INTEGER PRIMARY KEY,
  issue_number INTEGER NOT NULL,
  verdict      TEXT NOT NULL,          -- 'split' | 'coherent'
  concepts     TEXT NOT NULL,          -- JSON array of names; empty on 'coherent'
  reason       TEXT NOT NULL,
  files        INTEGER NOT NULL,       -- what the diff measured when it was read
  agent_id     TEXT,
  decided_at   TEXT NOT NULL
);
`;
