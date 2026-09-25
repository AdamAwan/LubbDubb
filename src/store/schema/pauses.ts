export const PAUSES_SCHEMA = `
-- Features an operator has paused: work under them is not picked up, and the
-- board draws them faded. A row is the whole of the statement — there is no
-- expiry, because a pause ends when the operator says so and a clock that
-- un-pauses on its own would put a feature back on the fleet unannounced.
--
-- Deliberately not a tracker label. The watch tag says whether an item is the
-- fleet's work at all and cascades onto every child; taking it off a paused
-- Feature would strip the children's tags and lose the operator's own tagging on
-- the way back. A pause leaves every tag exactly as it was.
CREATE TABLE IF NOT EXISTS goal_pauses (
  origin     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;
