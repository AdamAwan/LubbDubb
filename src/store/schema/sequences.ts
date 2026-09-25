export const SEQUENCES_SCHEMA = `
-- The order the stories under one Feature are worked in, and the operator's answer
-- to it (see SequenceStore). Only status='accepted' holds anything: a proposal
-- nobody has answered and an order somebody declined both leave the fleet behaving
-- exactly as it does with no row here at all.
--
-- standing_key digests *which* stories are under the Feature, never how they are
-- going — that is the whole difference from feature_summaries.standing_key, and it
-- is why a story merging does not re-propose an order while a story being added
-- does.
--
-- Both tables are new, so neither is owed a ColumnMigrations entry — but a table
-- being new *once* does not keep it exempt, and a column added to either later will.
CREATE TABLE IF NOT EXISTS feature_sequences (
  origin_ref   TEXT PRIMARY KEY,      -- "issue:29857", the Feature's own
  status       TEXT NOT NULL,         -- proposed | accepted | declined
  reason       TEXT NOT NULL,         -- why this order, in the sequencer's voice
  unsure       TEXT,                  -- the edge it would most like argued with
  standing_key TEXT NOT NULL,
  -- The stories the order was written over, as a JSON array. Nullable, and the
  -- null is load-bearing rather than incidental: a row from before this column
  -- cannot say which stories are new, so a re-sequence over it asks the operator
  -- again — exactly what every row did before. No backfill is owed for that
  -- reason. See SEQUENCE_COLUMNS.
  members      TEXT,
  answered_by  TEXT,                  -- who accepted or declined it
  answered_at  TEXT,
  agent_id     TEXT,                  -- null on a sequence built only from links
  task_id      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- One row per edge. Deleted and rewritten as a set whenever a sequence is written,
-- never merged: an edge dropped from an amended order has to disappear, and a merge
-- on (issue, depends_on) would leave it behind indistinguishable from one still
-- meant. A story with no row here waits on nothing and is in the first wave.
--
-- source is load-bearing rather than decorative: 'link' is a statement a person made
-- on their own board and 'inferred' is an agent's guess, and a surface that drew them
-- the same way would invite accepting the second thinking it was the first.
CREATE TABLE IF NOT EXISTS feature_sequence_edges (
  origin_ref TEXT NOT NULL,           -- the Feature the order belongs to
  issue      INTEGER NOT NULL,        -- the story that waits
  depends_on INTEGER NOT NULL,        -- the story it waits on
  source     TEXT NOT NULL,           -- link | inferred
  reason     TEXT,                    -- one line on why; null on a link
  PRIMARY KEY (origin_ref, issue, depends_on)
);
`;
