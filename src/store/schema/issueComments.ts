export const ISSUE_COMMENTS_SCHEMA = `
-- One row per issue comment the harness actually posted (see IssueCommentStore),
-- keyed by the provider's own id for it. Pulling a ticket's comments into its
-- discussion file skips these by record, never by author: on a single-operator
-- deployment the harness posts under the operator's own login, so an author test
-- would drop the operator's own comments. A comment sent before this table has no
-- row and is pulled like anyone else's.
CREATE TABLE IF NOT EXISTS issue_comments_sent (
  issue_number INTEGER NOT NULL,
  comment_ref  TEXT NOT NULL,     -- the provider's id, as upsertIssueComment answered it
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (issue_number, comment_ref)
);
`;
