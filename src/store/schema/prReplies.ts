export const PR_REPLIES_SCHEMA = `
-- One row per review-thread reply the harness actually sent (see PrReplyStore),
-- keyed by the provider's own id for the comment it created. Attribution is a
-- record, never an inference: reading it off the author marked the operator's own
-- follow-up on their own review thread as the fleet's answer, which folded to
-- PrComment.handled and dropped the comment before any rule saw it. A reply with
-- no usable ref writes no row and the thread keeps reading as work; there is no
-- backfill for replies sent before this table, because the only evidence left on
-- those is the author.
CREATE TABLE IF NOT EXISTS pr_replies_sent (
  pr_number   INTEGER NOT NULL,
  thread_id   TEXT NOT NULL,      -- the thread replied into, as PrComment carries its id
  comment_ref TEXT NOT NULL,      -- the provider's id for the comment created, as PrThreadMessage carries it
  sent_at     TEXT NOT NULL,
  PRIMARY KEY (pr_number, comment_ref)
);
`;
