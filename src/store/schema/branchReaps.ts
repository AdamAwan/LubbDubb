export const BRANCH_REAPS_SCHEMA = `
-- Pull requests whose merged branch has already been deleted, locally and on the
-- remote (see BranchReapStore). Keyed on the pull request rather than the branch:
-- a branch name is reusable, and a row keyed on the name would suppress the reap
-- owed to the *next* branch that wore it.
CREATE TABLE IF NOT EXISTS branch_reaps (
  pr_number INTEGER PRIMARY KEY,
  branch    TEXT NOT NULL,      -- what was deleted, for the audit trail
  at        TEXT NOT NULL
);
`;
