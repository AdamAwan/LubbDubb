export const PR_REVIEW_EXTERNALS_SCHEMA = `
-- Pull requests a check *outside* the harness reported already reviewed (see
-- PrReviewExternalStore). Its own table rather than a pr_reviews row, because that
-- row means "the fleet read this, and here is what it found" — writing an external
-- gate as one would put a verdict in the cockpit and in the next agent's prompt
-- that nothing in this harness ever performed. Only the "reviewed" verdict lands: a
-- gate that has not passed yet may pass later, and a row for the absence of an
-- answer would freeze it into one.
CREATE TABLE IF NOT EXISTS pr_review_externals (
  pr_number INTEGER PRIMARY KEY,
  detail    TEXT NOT NULL,      -- what said so, for the audit trail
  at        TEXT NOT NULL
);
`;
