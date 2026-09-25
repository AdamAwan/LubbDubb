export const OPERATIONS_SCHEMA = `-- Pets (docs/spec/22-pets.md). One vivarium per database: a deployment has one
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

-- The local run (see LocalRunStore): which goal's code is in the machine's one dev
-- environment. One row per run and the row outlives the run, so a start that failed
-- has its reason somewhere to read; the *live* one is whichever row is 'starting' or
-- 'running', and there is only ever one because the writer ends the last before it
-- writes a new one. The table is new, so it needs no ColumnMigrations entry — but
-- a table being new once does not keep it exempt, and a column added later will.
CREATE TABLE IF NOT EXISTS local_runs (
  id         TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,
  ref        TEXT NOT NULL,     -- the git ref the checkout was pointed at
  dir        TEXT NOT NULL,
  -- The commit the checkout stands at: written by the start, rewritten by a refresh.
  -- What the watch measures freshness from, since a ref names a branch and a branch
  -- moves. Null on a row from before the column -- where that checkout stood was
  -- never written down, and the freshness reading says so rather than guessing.
  -- Named commit_sha because COMMIT is a keyword.
  commit_sha TEXT,
  pid        INTEGER,           -- the session whose *subtree* a stop has to reap
  status     TEXT NOT NULL,
  url        TEXT,              -- as configured when the run started, not as it reads now
  note       TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  -- When the harness that was holding this run went down, stamped by the fast stop
  -- on its way out. It is the age a resume is judged on: an environment nobody has
  -- been near for hours is not one to bring back. Null on a row nothing stamped --
  -- a hard crash, where the harness never got a line -- which falls back to
  -- last_seen_at below, and is unknown only if that is null too.
  interrupted_at TEXT,
  -- The last beat on which the harness was holding this run, stamped from the pulse
  -- while a session of this process holds it. What dates a force close: taskkill,
  -- Task Manager, a power cut and a closed console window all take the process
  -- without running a line, so interrupted_at stays null and this is the only record
  -- of when the environment was last true. Stamped only by the process actually
  -- holding the run, so a live row a boot declined to bring back is never dated.
  last_seen_at TEXT
);

-- One dated cost delta per usage report a local run's sessions made -- the sibling
-- of usage_events, and separate from it because that table's agent_id is the join
-- the reliability breakdown prices a pull request's CI through. A row says what a
-- run came to and never when the money went, so a rolling window or a trend can
-- only be read off these.
CREATE TABLE IF NOT EXISTS local_run_cost_deltas (
  local_run_id TEXT NOT NULL,
  cost_usd     REAL NOT NULL,
  at           TEXT NOT NULL
);

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

-- One row per agent turn the model API refused ("API Error: ..."), read off the
-- stream transport's result event (docs/spec/18-observability.md#api-errors).
-- kind is 'safeguards' for a usage-policy flag, 'other' for anything else; code is
-- the bracketed Details tag, e.g. reasoning_extraction.
CREATE TABLE IF NOT EXISTS api_errors (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  origin_ref TEXT,
  model      TEXT,
  kind       TEXT NOT NULL,
  code       TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_calls (
  id         TEXT PRIMARY KEY,
  -- 'fleet' or 'desktop'. Never summed across: they are different credentials,
  -- different tool sets, and validation_report is two different tools.
  channel    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  agent_id   TEXT,
  task_id    TEXT,
  -- The origin the calling agent was dispatched on, copied at write time rather
  -- than joined at read time: the task outlives nothing, but the phase reading
  -- wants the ref as it was when the call happened, and a task retargeted later
  -- would silently re-file every call it ever made under a different phase.
  origin_ref TEXT,
  ok         INTEGER NOT NULL,
  -- The refusal in the tool's own words, when it refused. Null on success.
  error      TEXT,
  duration_ms INTEGER NOT NULL,
  -- The call's arguments as JSON, and the only column here that is ever cleared.
  -- Kept so "how is this tool used" is answerable, dropped after
  -- mcpArgsRetentionDays because it is the only part of a row that is
  -- unbounded and the only part that carries issue text and code.
  args       TEXT,
  -- What args measured before it was cleared, so the reading survives the
  -- compaction that removes the text. Written at insert, never updated.
  args_bytes INTEGER NOT NULL,
  -- Whether args has been compacted away, as distinct from a call that carried
  -- no arguments at all. Two very different rows would otherwise both read as
  -- args IS NULL, and the panel would report a fortnight of empty calls.
  args_dropped INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_local_run_cost_deltas_at ON local_run_cost_deltas(at);
CREATE INDEX IF NOT EXISTS idx_local_runs_status ON local_runs(status);
-- Each time the fleet was asked to drive the machine's dev environment and say
-- whether a goal's changes work (see LocalValidationStore). One row per press of
-- the button, kept after it ends: a validation abandoned because somebody swapped
-- the environment is the case an operator actually hits, and the reason has to be
-- readable afterwards.
--
-- run_id and commit_sha are the *pin*: which environment this reading was planned
-- against. Everything later compares the live run to them, because a report taken
-- after the checkout moved is a reading of code nobody asked about.
CREATE TABLE IF NOT EXISTS local_validations (
  id           TEXT PRIMARY KEY,
  origin_ref   TEXT NOT NULL,       -- the goal, as issue:<n>
  run_id       TEXT NOT NULL,       -- the local_runs row this was requested against
  ref          TEXT NOT NULL,       -- the branch that run had out; what a fix is dispatched onto
  commit_sha   TEXT,                -- named for local_runs' reason: COMMIT is a keyword
  status       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  dispatched_at TEXT,               -- when an agent actually spawned, not when one was proposed
  ended_at     TEXT,
  task_id      TEXT,                -- the validator
  fix_task_id  TEXT,                -- the fix, and the latch that keeps one failure to one fix
  plan         TEXT,                -- markdown, written before the environment was up
  summary      TEXT,
  findings     TEXT NOT NULL,       -- JSON array of LocalValidationFinding
  visited      TEXT NOT NULL,       -- JSON array of URLs the agent opened
  screenshots  TEXT NOT NULL,       -- JSON array of file names in the row's own output directory
  note         TEXT                 -- why it was abandoned, or what a blocked run could not reach
);
CREATE INDEX IF NOT EXISTS idx_local_validations_origin ON local_validations(origin_ref);
CREATE INDEX IF NOT EXISTS idx_agent_flags_agent ON agent_flags(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
`;
