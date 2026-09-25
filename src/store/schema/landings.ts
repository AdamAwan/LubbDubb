export const LANDINGS_SCHEMA = `
-- An operator's standing authorization to land a whole stack (see StackLanding).
-- Its own table rather than a proposal, because a proposal is a verdict on *one
-- formed act* and this is a verdict given before any of the acts exist: it
-- authorizes merges the harness has not proposed yet and will not propose for
-- several cycles. Filing it as a proposal would have needed a ref naming an act
-- that has no number yet, and a pending row nobody is being asked to answer.
--
-- The rungs column is the authorization and ref is not: the stack ref renames
-- itself the moment the bottom rung merges, so every lookup keys on PR numbers.
CREATE TABLE IF NOT EXISTS stack_landings (
  id         TEXT PRIMARY KEY,
  ref        TEXT NOT NULL,      -- "stack:124", as it read at the click
  rungs      TEXT NOT NULL,      -- JSON array of PR numbers, bottom-first
  status     TEXT NOT NULL,      -- standing | landed | stopped | revoked
  reason     TEXT,               -- why it stopped
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
