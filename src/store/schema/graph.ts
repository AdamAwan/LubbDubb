export const GRAPH_SCHEMA = `
-- The durable work graph: every node the harness has observed for a work item and
-- what it descended from. Written once per pulse from the world plus the store's
-- own rows, and never deleted — that is the whole feature. A merged PR ages out of
-- closedPullRequests after closedPrWindowMs, and without this the edge from an
-- issue to the PR that delivered it is unrecoverable from that moment on.
CREATE TABLE IF NOT EXISTS work_nodes (
  ref           TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  parent_ref    TEXT,
  base_ref      TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  terminal      INTEGER NOT NULL DEFAULT 0,
  provenance    TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- A work item the operator asked an agent to create in the tracker, for work the
-- harness did that nothing external accounts for (stage 3). Keyed on the node it
-- is for, so one node has at most one filing and a second click is refused by the
-- write. Two statuses for the reason a claim's ticket exit has them: filing is
-- asynchronous, so 'filing' means an agent is creating it and 'filed' is the one
-- carrying a ref.
--
CREATE TABLE IF NOT EXISTS work_item_filings (
  target_ref TEXT PRIMARY KEY,
  status     TEXT NOT NULL,          -- filing | filed
  ticket_ref TEXT,                   -- the item it was filed as ("issue:314"), once created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The other answer to the same question, and the reason it is a table of its own
-- rather than a third work_item_filings status: a filing is the harness creating
-- the item, and an ignore is the operator saying nothing should be. Keyed on the
-- node, so ignoring twice is one row and un-ignoring is a delete — which is what leaves the verdict exactly one
-- representation, the way clearing an issue conclusion does.
CREATE TABLE IF NOT EXISTS work_item_ignores (
  target_ref TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_ref);
`;
