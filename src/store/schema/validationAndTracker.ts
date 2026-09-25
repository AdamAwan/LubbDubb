export const VALIDATION_AND_TRACKER_SCHEMA = `-- How anyone checks that the *goal* was met: the executable form of the plan's
-- verification narrative. Per goal rather than per part — a check usually spans
-- parts, and the question it answers is whether the thing works — and keyed on the
-- goal for the same reason, rather than on whichever plan of the work declared it.
--
-- The id is author-chosen and stable, so an amended plan merges onto these rows;
-- the letter is assigned at ingestion and never reused, so the handle a person
-- types names one check for the life of the goal. The result is columns rather
-- than a table: a check has exactly one current reading, and the trail of how it
-- got there is the record beside it.
CREATE TABLE IF NOT EXISTS validation_checks (
  origin_ref  TEXT NOT NULL,          -- the goal, issue:<n> — not the plan; validation is per goal
  id          TEXT NOT NULL,          -- author-chosen kebab-case slug; the merge key
  letter      TEXT NOT NULL,          -- A, B, C… — the handle a person types
  seq         INTEGER NOT NULL,       -- declaration order, for rendering; never the letter
  title       TEXT NOT NULL,
  check_do    TEXT NOT NULL,          -- the procedure, markdown ("do" is a SQLite keyword)
  check_expect TEXT NOT NULL,         -- what a pass looks like
  uses        TEXT NOT NULL,          -- JSON array of resource *names*, never paths
  covers      TEXT NOT NULL,          -- JSON array of part slugs this check exercises
  satisfies   TEXT,                   -- JSON array of goal criteria (their text) this check answers
  fleet_candidate INTEGER NOT NULL DEFAULT 0,  -- the planner's nomination; dispatches nothing
  candidate_why   TEXT,               -- why an agent could run it; kept only with the nomination
  actor       TEXT,                   -- human | fleet — the operator's hand-over; never the planner's
  handback_note TEXT,                 -- why the fleet gave it back; cleared by the next reading
  claimed_by  TEXT,                   -- desktop session holding this check; one live claim harness-wide
  claimed_at  TEXT,                   -- when it was taken; a claim past desktopClaimMinutes holds nothing
  state       TEXT NOT NULL,          -- unrun | passed | failed | waived | deferred | captured. A value
                                      -- on an existing column, so no ALTER TABLE: "captured" is a
                                      -- screen waiting to be looked at, and a row from before it
                                      -- reads "unrun", which is what checkStateOf narrows to
  result_note TEXT,                   -- the one current reading: a result, a deferral's reason, a waiver's
  result_by   TEXT,                   -- operator | agent | desktop | spec | script; null while unrun.
                                      -- "script" is a one-off script's own assertion and is never
                                      -- folded with "spec", which had a reviewer
  result_at   TEXT,
  defer_until TEXT,                   -- when a deferral says it comes back; null is "not saying"
  superseded_reason TEXT,             -- set when an amendment stopped declaring it; null is live
  revision    TEXT,                   -- JSON: the wording an amendment replaced, and the reading it withdrew
  amended_at  TEXT,                   -- when an amendment last changed it; cleared by the next reading
  amend_note  TEXT,                   -- why it changed, in the amender's words
  steps       TEXT,                   -- JSON: the check's test plan, one ordered journey through the
                                      -- delivered goal, each step with the actor read off the
                                      -- configuration. NULL is "no steps", which is every row from
                                      -- before the column and stays true, so nothing is backfilled
  capture     TEXT,                   -- the screen a "screenshot" step handed back: a file NAME in the
                                      -- goal's validation directory, never a path and never an
                                      -- artefact URL. NULL is "no capture", true of every row from
                                      -- before the column, so nothing is backfilled
  proof       TEXT,                   -- what a pass must hand BACK, prose, written by the check's
                                      -- author before the run. NULL is "no evidence was demanded",
                                      -- true of every row from before the column and of every check
                                      -- whose assertion is the whole of its evidence, so nothing is
                                      -- backfilled — and it never folds into "evidence was demanded
                                      -- and none came", which is a blocked row
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (origin_ref, id)
);

-- A goal's validation plan, written in two halves. The plan document writes the
-- hint — prose intent, binding nothing — and the validation planner writes the
-- rest after the goal is delivered, against merged code.
--
-- The authored_at stamp is the fact nothing else holds. An empty check set is a
-- legitimate answer and is indistinguishable from a planner that never ran, so
-- sheet assembly waits on this stamp rather than on a check count: a sheet
-- assembled before the set is authored carries only the watch-derived rows and
-- reads as a misconfiguration.
CREATE TABLE IF NOT EXISTS validation_plans (
  origin_ref   TEXT PRIMARY KEY,      -- the goal, issue:<n>
  hint         TEXT,                  -- the plan's prose intent; null is a plan that declared none
  note         TEXT,                  -- where the planner departed from the hint, and why
  empty_reason TEXT,                  -- why nothing was declared; null where checks were
  authored_at  TEXT,                  -- null is "the check set has not been written yet"
  released_at  TEXT,                  -- null is "authored, and still a proposal an operator has not accepted"
  updated_at   TEXT NOT NULL
);

-- What a check needs that is not in the repository: a seeded fixture, a reference
-- screenshot, an account on an environment. Named rather than pathed — the path
-- an agent sees, the path the cockpit serves and the path an operator opens are
-- three different strings, and a stored absolute one is wrong for two of them the
-- moment the configured validation root moves.
CREATE TABLE IF NOT EXISTS validation_resources (
  origin_ref TEXT NOT NULL,           -- the goal, as above
  name     TEXT NOT NULL,
  kind     TEXT,                      -- fixture | access | reference | data; null = unstated
  note     TEXT,
  provided INTEGER NOT NULL DEFAULT 1, -- 0 is the planner asking for something it cannot produce
  human_task_id TEXT,                 -- the ask filed for an unprovided one, so a replan files it once
  PRIMARY KEY (origin_ref, name)
);

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

-- A deliberate upgrade of the harness's own build: one row, id 1. Persisted where
-- the pause flag beside it is not, because its point is to be read by the process
-- *after* the one that wrote it: the "applying" state tells the next boot that the
-- agents it finds interrupted were interrupted on purpose, and that their recovery
-- verdict has already been decided. See src/store/upgrades.ts.
CREATE TABLE IF NOT EXISTS upgrade_intent (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  state           TEXT NOT NULL,
  target_sha      TEXT,
  requested_at    TEXT,
  paused_by_drain INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

`;
