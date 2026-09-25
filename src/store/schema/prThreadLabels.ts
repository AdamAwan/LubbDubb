export const PR_THREAD_LABELS_SCHEMA = `
-- What the agent answering a review thread said the thread was about. One row per
-- thread rather than per reply: the fleet may come back to a thread several times and
-- the count wants the thread once. How often it came back is pr_replies_sent, which
-- keeps a row per reply that left. The path is stored and the area derived from it at
-- read time, so a correction to the area rules corrects the whole back-catalogue.
CREATE TABLE IF NOT EXISTS pr_thread_labels (
  pr_number     INTEGER NOT NULL,
  thread_id     TEXT NOT NULL,
  about_comment INTEGER NOT NULL,  -- the reviewer's point was about a code comment, not the code
  changed_code  INTEGER NOT NULL,  -- the agent changed code for it, rather than defending it
  resolved      INTEGER NOT NULL,  -- the reply asked the harness to mark the thread resolved
  path          TEXT,              -- repository-relative file the thread is anchored to; null for a PR-level thread
  author        TEXT,              -- who left the thread, to tell a review bot from a person
  author_is_bot INTEGER,           -- the provider's own word at the time; null where it said nothing
  agent_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  answered_at   TEXT NOT NULL,
  PRIMARY KEY (pr_number, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_thread_labels_answered ON pr_thread_labels(answered_at);
`;
