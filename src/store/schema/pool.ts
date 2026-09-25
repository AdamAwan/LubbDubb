export const POOL_SCHEMA = `
-- The cross-fleet pool's mirror of everybody else's documents (docs/spec/28-cross-fleet-pool.md).
--
-- **Derived and wholly replaceable**: rewritten on every poll, so dropping it and
-- re-polling gives an identical one. That is what keeps the pool from becoming
-- authoritative locally — every fleet's own SQLite stays the truth about that
-- fleet, and everything here is re-derivable from the documents.
--
-- Everybody else's digests, one row per (fleet, day, section key). Replaced whole
-- on every poll for that reason: it is a mirror, not a ledger.
--
-- "section" and "key" rather than a column per dimension, because the sections do
-- not share a key space — byPhase is a SpendPhase, byCause is a kind/cause/guard
-- triple, byCheck is a provider's own check name — and a table per section would
-- be three tables the aggregator has to remember to read all of.
CREATE TABLE IF NOT EXISTS pool_digest_rows (
  fleet_id TEXT NOT NULL,
  project  TEXT NOT NULL,
  day      TEXT NOT NULL,            -- a UTC day, YYYY-MM-DD. Never local midnight.
  section  TEXT NOT NULL,            -- phase | cause | check | unaccounted | unmeasured | usage | throughput
  key      TEXT NOT NULL,            -- the section's own key; empty for the two totals
  count    INTEGER NOT NULL,         -- runs, or accounts, or dispatches — the section says which
  cost_usd REAL,                     -- null where a window measured nothing; never 0.00 for it
  partial  INTEGER NOT NULL,         -- 1 for the origin's current day: counts in a total, never an average
  PRIMARY KEY (fleet_id, day, section, key)
);

-- One row per fleet whose document this harness has parsed, and the mirror's own
-- honesty: a fleet that is ahead of this build, one that could not be parsed, and
-- one that simply has not published are three different facts, and folding them
-- into an absence would say in the operator's words that nobody else knows
-- anything. → docs/spec/24-environments.md#the-three-verdicts, one level up.
CREATE TABLE IF NOT EXISTS pool_fleets (
  fleet_id      TEXT PRIMARY KEY,
  project       TEXT,
  digest_at     TEXT,                -- publishedAt of its digest document, or null
  ahead         INTEGER NOT NULL,    -- 1 when it wrote a schema version this build skips
  seen_at       TEXT NOT NULL
);

-- What this fleet has published, and whether it still matches what the store says.
-- One row per kind, so the two documents keep their own cadences.
--
-- "dirty" is a **hint and not a queue**: because publish is a whole-document put,
-- five rulings in a minute collapse to one publish and a failed push simply stays
-- dirty. "content_hash" is the truth — the slow clock re-derives both documents and
-- compares, so anything the flag loses to a crash self-heals within the hour.
CREATE TABLE IF NOT EXISTS pool_publications (
  kind          TEXT PRIMARY KEY,    -- digest
  content_hash  TEXT,                -- of the document last published successfully
  published_at  TEXT,
  dirty         INTEGER NOT NULL,
  checked_at    TEXT                 -- when the backstop last re-derived and compared
);

CREATE INDEX IF NOT EXISTS idx_pool_digest_project ON pool_digest_rows(project, day);
`;
