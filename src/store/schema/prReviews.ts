export const PR_REVIEWS_SCHEMA = `
-- The fleet's own review of a pull request (see PrReviewStore): one row per pull
-- request, written by the review_report tool.
--
-- Keyed on the pull request rather than on the commit it read, because the review
-- runs once: a key that moved with the diff would be invalidated by the first fix
-- pushed after the review, and with nothing re-reviewing, the merge gate would
-- never be satisfied again. head_sha records what was in front of the reviewer
-- and gates nothing.
CREATE TABLE IF NOT EXISTS pr_reviews (
  pr_number   INTEGER PRIMARY KEY,
  head_sha    TEXT,
  verdict     TEXT NOT NULL,   -- 'clear' | 'findings'
  summary     TEXT NOT NULL,
  findings    TEXT NOT NULL,   -- JSON array of strings
  agent_id    TEXT,
  reviewed_at TEXT NOT NULL,
  -- The provider's id for the thread the findings were published into, where one
  -- went out and the provider named it. Nullable, matching the ALTER TABLE that
  -- adds it to a database from before it existed: null is what every row written
  -- then meant — nothing recorded published this review — and it needs no backfill
  -- because there is nothing to read it from.
  published_thread TEXT
);
`;
