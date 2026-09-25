export const SURFACE_REACH_SCHEMA = `
-- Every MCP tool call that reached a tool body, on either channel.
--
-- The one thing the harness never wrote down. Which tools the fleet actually
-- reaches for -- and which it never does -- was answerable only by reading
-- transcripts one at a time, and the failure that matters most is not visible in
-- a transcript at all: an agent whose mcp__lubbdubb__* grants were dropped
-- makes no call, says nothing about it, and finishes.
--
-- A row per call rather than a counter, because the two readings this table
-- exists for both need the individual call: a silence is diagnosed by joining
-- against the runs that existed, and "how is this tool actually used" is a
-- question about arguments.
--
-- agent_id and task_id are null on purpose in two cases: a desktop call has
-- no dispatch behind it, and a fleet call that arrived on an unresolvable
-- credential has no identity to attribute. Both are worth keeping -- the second
-- especially, since a channel answering refusals is exactly what this is for.
-- Surface reach: what an operator looked at, and what they did there.
--
-- The one table in the tree that records the *operator* rather than the fleet,
-- and the only signal genuinely absent from everything else here: nothing else
-- knows a pull request page was ever opened.
--
-- Five columns and no more, and the shape is the privacy position rather than a
-- summary of it. No ref, no title, no free text -- and no identity column, which
-- is refused rather than omitted: a fleet is an engineer, so the fleet id already
-- carries whose behaviour a row describes.
--
-- Nothing gates on it. No dispatch rule, desk or tool reads this table; the only
-- reader is buildSurfaceReach. Retention is ninety days, matching the digest's.
CREATE TABLE IF NOT EXISTS surface_reach (
  -- The registry's two axes (src/usage/events.ts). A subject is a thing the
  -- product offers, never a screen, so a control that moves keeps its row.
  subject TEXT NOT NULL,
  verb    TEXT NOT NULL,
  -- The cockpit's own place vocabulary. Local to this fleet: a redesign moves it,
  -- so the digest is keyed on subject and verb and never on this.
  place   TEXT NOT NULL,
  at      TEXT NOT NULL,
  -- 'linked' or 'direct'. What tells never-linked from linked-never-visited.
  arrival TEXT NOT NULL
);

-- Every reading folds a window, so the date is the only selective column. The
-- second index is the compaction's own: it sweeps by date for rows that still
-- carry arguments, and without it that is a full scan on every boot.
-- Every read of surface_reach is a window fold or the retention sweep, and both
-- cut on the date alone.
CREATE INDEX IF NOT EXISTS idx_surface_reach_at ON surface_reach(at);
`;
