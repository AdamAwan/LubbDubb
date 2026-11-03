export const ISSUE_COMMENTS_SCHEMA = `
-- → docs/spec/14-persistence.md
CREATE TABLE IF NOT EXISTS issue_comments_sent (
  issue_number INTEGER NOT NULL,
  comment_ref  TEXT NOT NULL,     -- the provider's id, as upsertIssueComment answered it
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (issue_number, comment_ref)
);
`;
