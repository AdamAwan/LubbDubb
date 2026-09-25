export const PROFILE_OVERRIDES_SCHEMA = `
-- Goals the operator has marked a priority. One row per flagged goal, keyed on
-- its issue:<n> origin; presence is the whole value, so there is no rank and no
-- ordering among flagged goals (the pipeline order decides that, per goal).
--
-- Deliberately not pruned the way priority_overrides is. An override arranges one
-- pulse's queue and is meaningless once its origin stops being ranked; this is a
-- standing statement about a goal, and a goal with nothing queued — waiting on a
-- human, on a review, on a base — is exactly when it must survive. It is cleared
-- by the operator and by nothing else.
-- Operator overrides of which model profile a queued dispatch runs on. One row
-- per candidate origin, on exactly the terms priority_overrides is
-- kept on: keyed on the stable origin because the queue is a per-pulse
-- projection, and pruned by the same last_seen_at sweep once the harness stops
-- tracking that origin. A separate table rather than a column on
-- priority_overrides because the two statements are independent — an operator who
-- re-orders a row has said nothing about what it should run on, and one row
-- carrying both would make clearing either one a read-modify-write.
CREATE TABLE IF NOT EXISTS profile_overrides (
  origin       TEXT PRIMARY KEY,
  profile      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`;
