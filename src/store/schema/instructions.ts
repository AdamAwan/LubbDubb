export const INSTRUCTIONS_SCHEMA = `
-- What the operator has told the fleet to do on a goal, in their own words. Not a
-- verdict and not keyed like one: a conclusion is one overwritten row per issue,
-- so a second instruction written while the first was still outstanding would
-- silently replace it. These accumulate instead, and every one still standing is
-- appended to every dispatch on the goal.
--
-- settled_at is the whole lifecycle: an agent's conclude_work settles the ones it
-- was working under, and the operator can withdraw one. A settled row is kept
-- rather than deleted so the trail of what was asked for survives the asking.
CREATE TABLE IF NOT EXISTS issue_instructions (
  id         TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,         -- "issue:12", always the whole goal
  text       TEXT NOT NULL,         -- the operator's words, verbatim
  created_at TEXT NOT NULL,
  settled_at TEXT                   -- null while it stands
);

CREATE INDEX IF NOT EXISTS idx_issue_instructions_origin ON issue_instructions(origin_ref);
`;
