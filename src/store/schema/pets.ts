export const PETS_SCHEMA = `
-- Pets (docs/spec/22-pets.md). One vivarium per database: a deployment has one
-- collection however many projects it works across, so no row here names an owner.
--
-- The unique origin is the whole of what makes the scan idempotent. A roll is a
-- hash of the action's identity, so re-reading an action produces the same
-- creature; this constraint is what makes writing it again a no-op rather than a
-- second pet.
CREATE TABLE IF NOT EXISTS pets (
  id          TEXT PRIMARY KEY,
  species     TEXT NOT NULL,
  seed        TEXT NOT NULL,      -- the action key it hatched from; drives its colours
  name        TEXT,               -- the operator's, or null for the species' own
  fed         INTEGER NOT NULL DEFAULT 0,   -- beats spent on it; the only input to its stage
  origin_kind TEXT NOT NULL,
  origin_ref  TEXT NOT NULL,
  hatched_at  TEXT NOT NULL,      -- when the action happened, not when the scan reached it
  opened_at   TEXT,               -- when the operator cracked the shell; null while it is an egg
  placed      INTEGER NOT NULL DEFAULT 0,   -- 0/1: standing in the vivarium
  dissolved_at TEXT,                -- when a duplicate was blended; the row survives it
  built_sha   TEXT,               -- the harness build that rolled it, or null for no reading
  built_clean INTEGER NOT NULL DEFAULT 0,  -- 0/1: that build's own tree carried no edits
  chain       TEXT,               -- this row's link in the hatch chain (see chainLink)
  UNIQUE (origin_kind, origin_ref)
);

-- Every operator action the scan has rolled, hatched or not. Recorded for the
-- misses too, because "how many actions since the last pet" is what the pity rule
-- reads and a table of hatches alone cannot answer it.
CREATE TABLE IF NOT EXISTS pet_actions (
  kind   TEXT NOT NULL,
  ref    TEXT NOT NULL,
  at     TEXT NOT NULL,
  pet_id TEXT,                    -- what it hatched, or null for a miss
  PRIMARY KEY (kind, ref)
);

-- One row per beat spent. The only source of the wallet total the cockpit shows as
-- spent, summed at read time rather than kept in a column beside it.
CREATE TABLE IF NOT EXISTS pet_purchases (
  id         TEXT PRIMARY KEY,
  pet_id     TEXT NOT NULL,
  beats      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per duplicate blended back into beats. The credit is stored rather than
-- derived from the dissolved pets, because its value depends on blendYield — a
-- derived figure would rewrite history the day that key is tuned.
CREATE TABLE IF NOT EXISTS pet_blends (
  id         TEXT PRIMARY KEY,
  pet_id     TEXT NOT NULL,
  beats      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per time the collection was cleared, keyed by the clearance's own name
-- so a build asks "has *this* one run" rather than "has any". The row is what
-- makes a clearance happen exactly once however many times the harness restarts.
--
-- The timestamp is also the epoch the wallet counts fleet spend from: beats are
-- derived from usage_events, which only ever grows, so without a floor a cleared
-- vivarium would open holding every beat the deployment had ever earned.
CREATE TABLE IF NOT EXISTS pet_resets (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  cleared INTEGER NOT NULL     -- how many pets it released; kept for the record
);

-- When this vivarium started counting, and the whole of what makes an action from
-- before the feature existed inert rather than owed. One row, forever: a database
-- carries one collection, so the key is pinned to 1 rather than naming anything.
--
-- Stamped by the keeper's first enabled scan, and re-stamped by a clearance inside
-- the same transaction that releases the pets. Its absence is the migration gate —
-- stronger than "the column arrived this boot", because it is true on exactly one
-- boot however the schema got here.
CREATE TABLE IF NOT EXISTS pet_vivarium (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL  -- actions stamped before this are recorded and roll nothing
);

CREATE INDEX IF NOT EXISTS idx_pet_actions_at ON pet_actions(at);

CREATE INDEX IF NOT EXISTS idx_pet_purchases_pet ON pet_purchases(pet_id);
`;
