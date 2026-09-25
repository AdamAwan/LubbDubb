export const REMEDIES_SCHEMA = `
-- Why the fleet had to come back to a pull request, and what settled it: one row
-- per CI failure or review round an agent answered, written by that agent through
-- the report_remedy tool.
--
-- A record, not a verdict. Nothing gates on a row here, no dispatch rule reads the
-- table, and a pull request goes green whether or not one was filed — the two
-- readers are the Causes reading on the Yield panel and the prior-remedy note a
-- later dispatch on the same check carries.
--
-- kind, pr_number and checks are all resolved from the caller's credential (its
-- task's origin and ci_checks) rather than from arguments, which is what makes the
-- counts worth anything: a kind an agent could assert is a column reporting
-- whatever each agent took it to mean.
--
-- Its own table rather than columns on tasks: one run can settle several reds and
-- one red can take several runs, so the two do not share a key, and a nullable
-- cause on every task row would make "no remedy filed" and "not that kind of task"
-- indistinguishable.
CREATE TABLE IF NOT EXISTS remedies (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,        -- ci | review
  origin_ref TEXT NOT NULL,        -- pr:<n>:ci | pr:<n>:comments
  pr_number  INTEGER NOT NULL,
  cause      TEXT NOT NULL,        -- what was wrong (see RemedyCause)
  guard      TEXT NOT NULL,        -- what would have caught it (see RemedyGuard)
  summary    TEXT NOT NULL,        -- one line: what was wrong, what fixed it
  checks     TEXT,                 -- JSON array of check names, from the task; null for a review remedy
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Both readers select by date: the panel folds a window, and the prior-remedy note
-- takes the most recent few. Neither ever asks for a remedy by id.
CREATE INDEX IF NOT EXISTS idx_remedies_created ON remedies(created_at);

CREATE INDEX IF NOT EXISTS idx_remedies_pr ON remedies(pr_number);
`;
