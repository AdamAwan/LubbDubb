export const REVIEW_WAITS_SCHEMA = `
-- How long a pull request has been sitting on a reviewer, as one watermark per PR
-- (see ReviewWaitStore). Stored because the question is about a *span* and every
-- other reading here is about an instant: no provider payload says "reviewable
-- since", and the moment a pull request became reviewable is not recoverable from
-- a later snapshot of it. Deleted the moment it stops waiting, so the table holds
-- only what is currently outstanding.
CREATE TABLE IF NOT EXISTS pr_review_waits (
  pr_number INTEGER PRIMARY KEY,
  since     TEXT NOT NULL
);
`;
