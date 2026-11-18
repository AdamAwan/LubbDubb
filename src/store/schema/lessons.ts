export const LESSONS_SCHEMA = `
-- One row per repo-lesson draft (docs/spec/41-repo-lessons.md#the-record-and-the-desk):
-- the life of a draft, never the lesson. What a lesson says is in the repository it
-- landed on, or nowhere. Opened by LessonDesk for the top candidate group, claimed by
-- the dispatch that starts its agent, concluded by lesson_conclude, and settled by
-- the desk: unanswered when the agent's task ended without concluding, adopted or
-- declined when its pull request merged or closed.
CREATE TABLE IF NOT EXISTS lesson_drafts (
  id          TEXT PRIMARY KEY,
  group_key   TEXT NOT NULL,        -- \${kind}/\${cause}/\${where}
  kind        TEXT NOT NULL,        -- ci | review
  cause       TEXT NOT NULL,
  place       TEXT NOT NULL,        -- the group's where: a check, or a review area
  goals       TEXT NOT NULL,        -- JSON array of goal refs (issue:<n>, or pr:<n> for a goal-less pull request); its length is what a redraft must span again
  misses      TEXT NOT NULL,        -- JSON [{remedyId, prNumber, goal, guard, summary}]
  briefing    TEXT NOT NULL,
  status      TEXT NOT NULL,        -- pending | dispatched | pr-open | adopted | declined | filed | nothing | unanswered
  task_id     TEXT,
  fix         TEXT,                 -- code | guard | contradiction | note
  title       TEXT,
  summary     TEXT,
  reason      TEXT,
  pr_number   INTEGER,
  ticket_ref  TEXT,                 -- the ticket a filed lesson became, or the Task linked to a lesson pull request
  created_at  TEXT NOT NULL,
  settled_at  TEXT
);

-- One draft out at a time, across every group: the lock is the index, across a restart.
CREATE UNIQUE INDEX IF NOT EXISTS lesson_drafts_out
  ON lesson_drafts ((1)) WHERE status IN ('pending', 'dispatched');

-- One live draft per group: a group with a pull request open is not drafted again.
CREATE UNIQUE INDEX IF NOT EXISTS lesson_drafts_live
  ON lesson_drafts (group_key) WHERE status IN ('pending', 'dispatched', 'pr-open');
`;
