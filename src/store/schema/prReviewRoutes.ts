export const PR_REVIEW_ROUTES_SCHEMA = `
-- How the harness decided to read a pull request: the triage's verdict, naming one
-- of the modes the project declared (see PrReviewRouteStore).
--
-- Separate from pr_reviews because the merge gate is satisfied by a pr_reviews row
-- existing: a row written early to carry a route would report the pull request as
-- reviewed by the step that only decided how to review it.
CREATE TABLE IF NOT EXISTS pr_review_routes (
  pr_number  INTEGER PRIMARY KEY,
  mode       TEXT NOT NULL,          -- empty on a skip: no mode was chosen
  -- 1 = the triage decided this pull request needs no review at all (review.allowSkip).
  -- Nullable, matching the ALTER TABLE that adds it to a database from before it
  -- existed: null is what those rows meant — routed and reviewed — so there is no
  -- backfill, and the column has one shape everywhere.
  skipped    INTEGER,
  reason     TEXT NOT NULL,
  agent_id   TEXT,
  decided_at TEXT NOT NULL
);
`;
