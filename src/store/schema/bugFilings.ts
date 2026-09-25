export const BUG_FILINGS_SCHEMA = `
-- A bug the operator raised against a story from the cockpit: they ran the thing
-- and it does not do what they expect, which is the one fact no agent on the goal
-- can derive. Keyed on the *job*, not the story, so one story can carry several
-- bugs over its life — the difference from work_item_filings above, whose target
-- key deliberately allows one filing per node. It still has a job because a bug is
-- still written up by a desk agent (#394 kept that arm and took the *create* off
-- it); a work item's filing has none, because nothing is dispatched for one.
--
-- The operator's report is not a column: the desk job's prompt carries it verbatim
-- and is durable, and a second copy is two records of one sentence free to drift.
CREATE TABLE IF NOT EXISTS issue_bug_filings (
  job_id     TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,          -- the story it was raised from ("issue:12")
  status     TEXT NOT NULL,          -- filing | filed
  ticket_ref TEXT,                   -- the bug it was filed as ("issue:314"), once created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_bug_filings_origin ON issue_bug_filings(origin_ref);
`;
