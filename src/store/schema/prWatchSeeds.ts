export const PR_WATCH_SEEDS_SCHEMA = `
-- Pull requests the harness has already tagged with the watch label because it
-- opened them (see PrWatchSeedStore). Stored because the live labels cannot answer
-- it: a pull request an operator has un-watched looks exactly like one never
-- reached, and re-tagging it would undo the operator's own click every pulse.
CREATE TABLE IF NOT EXISTS pr_watch_seeds (
  pr_number INTEGER PRIMARY KEY,
  branch    TEXT NOT NULL,      -- what it was tagged for, for the audit trail
  at        TEXT NOT NULL
);
`;
