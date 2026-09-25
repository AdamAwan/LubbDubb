export const TICKETS_SCHEMA = `
-- The ticket mirror: every item the tracker's assignment filter has returned since
-- the harness first swept, in whatever state it was last seen in (issue #329).
--
-- A record, not a world. Nothing dispatches from this — the dispatcher reads the
-- live issue list, which is open items by construction — and nothing here is ever
-- deleted, which is the whole difference between it and a cache. An item the
-- tracker stops returning (closed, untagged, reassigned) keeps its last-seen row,
-- because the question the tab answers is "what has this fleet been asked to do",
-- and a history that forgets cannot answer it.
--
-- No index beyond the primary key, and that is deliberate: number **is** the
-- default ordering (a tracker id is auto-incremental, so id order is arrival
-- order), and the other reading — cost — is not this table's to know. See
-- src/tickets/ticketList.ts for where the rest of the query happens and why.
--
-- first_seen_at is the sweep that first wrote the row and never moves; added_at
-- is the tracker's own creation instant, which is what the row *displays*, and the
-- two differ by exactly the backfill: on the first sweep every row is first seen at
-- once.
CREATE TABLE IF NOT EXISTS tracker_items (
  number          INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  labels          TEXT NOT NULL,     -- JSON array
  state           TEXT NOT NULL,     -- 'open' | 'closed', the tracker's word
  url             TEXT,
  added_at        TEXT NOT NULL,     -- the tracker's created date; the default ordering
  changed_at      TEXT NOT NULL,     -- the tracker's last-modified; the sweep's high-water mark
  first_seen_at   TEXT NOT NULL,     -- frozen
  updated_at      TEXT NOT NULL,
  -- 'live' | 'frozen'. Frozen is an item that has left the tracker's open set: it
  -- keeps every field it was last seen with and is no longer enriched from the
  -- world. Not a second copy of state -- a provider with native states can close
  -- an item several ways, and this says what the *harness* does about it.
  tracking        TEXT NOT NULL DEFAULT 'live',
  work_item_state TEXT,              -- the provider's own word (Azure); null where there is none
  issue_type      TEXT,              -- 'Feature' / 'Task' / …; null on a flat tracker
  -- The hierarchy parent, last seen. Two columns and a flag rather than one
  -- nullable id, because a null id would collapse "no parent" into "we could not
  -- read the parent", which the provider is careful to keep apart.
  parent_number   INTEGER,
  parent_title    TEXT,
  parent_known    INTEGER NOT NULL DEFAULT 0,  -- 0 = never resolved, 1 = resolved (parent may still be null)
  last_read_at    TEXT               -- the last sweep that saw this item in the live set
);

-- Which colour each feature is drawn in, as a slot on a fixed ladder rather than a
-- hex string: the palette belongs to the stylesheet, and a stored colour would be a
-- second opinion about it that no theme change could reach. Assigned
-- least-used-first on first sight and then never moved — the whole value of the
-- column is that the same feature is the same colour tomorrow.
CREATE TABLE IF NOT EXISTS feature_colors (
  number      INTEGER PRIMARY KEY,
  slot        INTEGER NOT NULL,
  assigned_at TEXT NOT NULL
);

-- What a developer would tell a product owner about one Feature: prose, written by
-- the feature-summary rule's desk agent, revised whenever something under the Feature
-- moves.
--
-- A fresh table rather than columns on feature_colors, which is an assignment
-- nothing may re-decide, where this is rewritten. standing_key is the whole of the
-- re-write trigger: it is the digest of where every child stood when the row was
-- written (featureStandingKey), and the rule dispatches exactly when it differs
-- from the standing now — so an unchanged Feature costs one string comparison a
-- pulse and no agent, for ever.
CREATE TABLE IF NOT EXISTS feature_summaries (
  origin_ref   TEXT PRIMARY KEY,      -- "issue:29857", the container's own
  headline     TEXT,                  -- how far along, in a few words
  standing     TEXT NOT NULL,         -- the lede: where this Feature is
  usable       TEXT,                  -- what a person can see or use today
  blocked      TEXT,                  -- what is stopping the rest
  remaining    TEXT,                  -- what is left
  standing_key TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- The sweep's own bookkeeping: one row, id 1. anchor_at is one month before the
-- first sweep and is **frozen** — a rolling window would drop the far end of the
-- history every night, silently, which is the opposite of what the mirror is for.
-- swept_to is the high-water mark the next changed-since read asks from.
-- restated_at is stamped by the first sweep that lands and never moves: it marks
-- that the history has been read once with the provider's native state carried on
-- every row. Null on a database written before the sweep read that field, which is
-- what makes the one-time re-read from the anchor fire exactly once.
CREATE TABLE IF NOT EXISTS tracker_sweep (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  anchor_at   TEXT NOT NULL,
  swept_to    TEXT,
  restated_at TEXT,
  updated_at  TEXT NOT NULL
);
`;
