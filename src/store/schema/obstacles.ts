export const OBSTACLE_SCHEMA = `-- The account's Claude usage windows, as one row (id is pinned to 1).
--
-- Read off the CLI's own rate_limit_event on the stream transport, which every
-- live agent receives — so this is the fleet's single answer to "how much of the
-- five hours is spent", not a per-agent figure. captured_at dates it, because a
-- reading only arrives when an agent takes a turn: an idle fleet's is stale, and
-- the cockpit says so rather than pretending otherwise.
--
-- Each window is independently nullable: API-key auth carries no windows at all,
-- and an older CLI carries only some.
CREATE TABLE IF NOT EXISTS account_rate_limits (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  five_hour_used_percentage REAL,
  five_hour_resets_at       TEXT,
  seven_day_used_percentage REAL,
  seven_day_resets_at       TEXT,
  captured_at               TEXT NOT NULL
);

-- The same readings, kept rather than overwritten — the account's usage windows
-- as a series instead of a single latest figure (issue #431).
--
-- account_rate_limits above answers "how much is spent right now", which is all
-- the usage chip ever needed, and it answers it by throwing the previous reading
-- away on every turn. A percentage over *time* — and any attribution of it to the
-- work that spent it — has to be read off rows nothing overwrites, so the same
-- reading lands twice: once on the row above, once here.
--
-- captured_at is the primary key rather than a surrogate id, because two agents
-- reporting the identical instant are reporting one reading of one account. The
-- windows are independently nullable here for the same reason they are above.
-- ---------------------------------------------------------------------------
-- The obstacle board (docs/spec/27-obstacles.md). Something broken now, which a
-- fix ends — a red base branch, a wedged runner, a flaking check — or a note:
-- something true of the repository the repository does not say.
--
-- Three tables, and the split is the design. The row is what the fleet is told;
-- the keys are its identity; the sightings are who said it, in their own words.
CREATE TABLE IF NOT EXISTS obstacles (
  id         TEXT PRIMARY KEY,
  what       TEXT NOT NULL,        -- one line, the reporter's words with its own frame stripped
  kind       TEXT NOT NULL,        -- obstacle | note, from "would a fix make this go away?"
  state      TEXT NOT NULL,        -- sighted | standing | owned | resolved | dormant | muted
  owner_ref  TEXT,                 -- the ticket or repair dispatch fixing it; null while nothing is
  until      TEXT,                 -- the reporter's clock, read only by the backstop; null for most
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,      -- the newest sighting, which is what decay reads
  ended_by   TEXT,                 -- condition | landing | expiry | decay | written-down; null while nothing has
  -- The operator's answer to the bug this row would be filed as: approved | declined.
  -- Null is "not asked yet", which is where a proposal waits — and it waits as a
  -- standing row, so every automatic exit standing has still applies to it
  -- (docs/spec/27-obstacles.md#the-ticket-is-proposed-never-filed).
  ticket_decision TEXT
);

-- What identifies an obstacle: a fact about the world, never a sentence about it.
--
-- UNIQUE is on value **and not on (kind, value)**, which is the whole of why
-- deduplication is an index lookup rather than a judgement: two agents may
-- reasonably disagree about whether something is a flaking test or a broken
-- check, and a key on the pair would split one obstacle into two on that
-- disagreement — the prose problem rebuilt with a smaller vocabulary. The kind is
-- recorded because it says what was checked against what, and nothing that
-- matches reads it.
--
-- binds is whether this key may resolve an obstacle at all: signature and
-- cmd never do, and neither does a key that failed grounding. confirmations
-- counts how often a suggestion on it was confirmed, which is what a later change
-- promoting a signature to binding would read.
CREATE TABLE IF NOT EXISTS obstacle_keys (
  id          TEXT PRIMARY KEY,
  obstacle_id TEXT NOT NULL,
  kind        TEXT NOT NULL,       -- check | test | path | signature | cmd
  value       TEXT NOT NULL UNIQUE,
  binds       INTEGER NOT NULL,
  confirmations INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

-- Who said it, one row per voice, each carrying the reporter's own words.
--
-- Never a counter on the obstacle: the count is what carries a row to standing,
-- and the words are what the second agent reads instead of spending ten turns.
-- goal_ref is the goal rather than the dispatch origin (pr:412:ci and
-- pr:412:comments are two origins and one observation) and session_id is beside
-- it so a re-dispatch that inherited a conversation is not counted twice.
-- transition names what the harness observed, for a harness voice, and is null
-- for an agent's: the transition is the identity, so one check going red is one
-- voice however many pulses see it still red.
CREATE TABLE IF NOT EXISTS obstacle_sightings (
  id          TEXT PRIMARY KEY,
  obstacle_id TEXT NOT NULL,
  agent_id    TEXT,
  task_id     TEXT,
  goal_ref    TEXT,
  session_id  TEXT,
  transition  TEXT,
  words       TEXT NOT NULL,       -- the reporter's own sentence, verbatim
  why_not_mine TEXT,               -- required at the intake, read by nobody but an operator
  matched_by  TEXT NOT NULL,       -- the key that bound it ("check:test (windows)"), or "fresh"
  created_at  TEXT NOT NULL
);

-- Which agents have already been told about which obstacle, one row per pair.
--
-- The primary key **is** the "once per agent per obstacle, ever" rule: a notice
-- that arrives twice reads as a second problem, and a rule spelled as a
-- constraint cannot be forgotten by a later writer the way a convention can. The
-- reason is recorded for the page and read by nothing that decides.
CREATE TABLE IF NOT EXISTS obstacle_notices (
  obstacle_id TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  reason      TEXT NOT NULL,       -- standing | owned | resolved
  created_at  TEXT NOT NULL,
  PRIMARY KEY (obstacle_id, agent_id)
);

-- Which goal is parked behind which obstacle: the blocked verdict's row.
--
-- origin_ref is the primary key, so a goal is behind one obstacle at a time — the
-- one the agent named, which is the one it could not get past. Not a member of the
-- issue-verdict matrix (src/store/verdicts.ts): those four answer "is the work
-- finished" and clear each other, and this answers "can it be worked at all right
-- now". Its exit is the obstacle rather than the issue, so the desk that clears it
-- reads the board and never the goal.
CREATE TABLE IF NOT EXISTS obstacle_blocks (
  origin_ref  TEXT PRIMARY KEY,
  obstacle_id TEXT NOT NULL,
  agent_id    TEXT,
  task_id     TEXT,
  note        TEXT NOT NULL,      -- what the agent said it could not get past
  created_at  TEXT NOT NULL
);

-- The conditions the harness has promised to watch for an obstacle, and how far
-- through the two consecutive readings each one is.
--
-- Written by the harness and never by an agent: settling one means reading a world
-- object pulse after pulse, and the only party that can promise to do that is the
-- one already reading it. An agent naming a condition would be naming something
-- nothing watches.
--
-- met_at is the *first* of the two consecutive real world readings a resolution
-- needs, and a reading that finds the condition unmet clears it back to null — so
-- "two consecutive" is a fact about this column rather than a promise. A local
-- cycle serves no reading at all and never touches these rows: a resolution on a
-- stale reading closes an obstacle that is still live, the fleet pays for it
-- again, and nothing is red.
CREATE TABLE IF NOT EXISTS obstacle_conditions (
  id          TEXT PRIMARY KEY,
  obstacle_id TEXT NOT NULL,
  kind        TEXT NOT NULL,       -- check-green, the one kind to start
  check_name  TEXT NOT NULL,       -- the provider's own name, from a binding check key
  branch      TEXT NOT NULL,       -- the branch the harness saw it failing on
  met_at      TEXT,                -- the first of the two readings; null while unmet
  created_at  TEXT NOT NULL,
  UNIQUE (obstacle_id, check_name, branch)
);

-- A note being written into the repository: the documentation job, and what became
-- of it.
--
-- obstacle_id is the primary key, so a note is written up **once, ever**. A
-- write-up that was abandoned leaves the note standing to decay like anything
-- else; re-queueing it every pulse would be the subsystem whose point is not
-- spending the fleet twice on one thing spending it on itself.
CREATE TABLE IF NOT EXISTS obstacle_writeups (
  obstacle_id TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  pr_ref      TEXT,                -- stamped as soon as the graph shows one
  outcome     TEXT,                -- landed | abandoned; null while it is still going
  created_at  TEXT NOT NULL,
  settled_at  TEXT
);

-- What the model desk read off one obstacle's prose, and when it read it
-- (docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not).
--
-- One row per obstacle, upserted: a reading is a restatement of the whole row
-- rather than a log, and an operator asking what the desk made of something is
-- asking about the sightings it holds now.
--
-- read_at is the obstacle's own last_seen_at as it stood when the desk read it,
-- which is what makes the inbox a comparison rather than a clock: a row nobody has
-- said anything new about is a row already read, and a row a further voice has
-- landed words on is back in the inbox. purpose, title and body are the desk's
-- prose and its answer to what the row is for; every one of them is nullable,
-- because a reading that came back without one is dropped in that half and kept in
-- the rest — the gates' own rule.
CREATE TABLE IF NOT EXISTS obstacle_readings (
  obstacle_id TEXT PRIMARY KEY,
  read_at     TEXT NOT NULL,      -- the last_seen_at this reading was taken from
  taken_at    TEXT NOT NULL,
  purpose     TEXT,               -- ticket | docs; what the desk says the row is for
  title       TEXT,               -- the ticket's title, written from the sightings
  body        TEXT                -- and its body; null leaves the mechanical composition
);

-- Two rows something thinks are one obstacle, which is the one thing here nothing
-- may act on.
--
-- **A suggestion and never a merge.** Deciding two reports are one obstacle is the
-- job no model may do: a wrong merge hides one agent's report inside another's,
-- the swallowed report is answered "already owned", nobody fixes it, and nothing
-- is red. So the pair lands here, is answered into the intake's near[], and an
-- agent or an operator confirms it by id — or nobody does and the rows stay apart.
-- source says what proposed it: the desk's own reading, or a key it extracted that
-- another row already holds.
CREATE TABLE IF NOT EXISTS obstacle_suggestions (
  obstacle_id  TEXT NOT NULL,
  suggested_id TEXT NOT NULL,
  source       TEXT NOT NULL,     -- model | key
  created_at   TEXT NOT NULL,
  PRIMARY KEY (obstacle_id, suggested_id)
);

-- An operator taking a running agent's work into their own Claude Code. The row is
-- the hold: while it stands unsettled it keeps the origin off the dispatcher and
-- keeps the worktree slot out of the pool, neither of which survives the agent's
-- own task settling. last_seen_at null means nobody has contacted the harness about
-- this claim at all, which is not the same as a stale timestamp.
CREATE TABLE IF NOT EXISTS ejections (
  id            TEXT PRIMARY KEY,
  origin_ref    TEXT NOT NULL,
  branch        TEXT,
  worktree_path TEXT,
  agent_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  session_id    TEXT,
  reason        TEXT NOT NULL,
  ejected_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  last_note     TEXT,
  settled_at    TEXT,
  outcome       TEXT,
  settle_note   TEXT
);

CREATE TABLE IF NOT EXISTS rate_limit_readings (
  captured_at               TEXT PRIMARY KEY,
  five_hour_used_percentage REAL,
  five_hour_resets_at       TEXT,
  seven_day_used_percentage REAL,
  seven_day_resets_at       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ejections_live ON ejections(origin_ref) WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_attachments_target ON job_attachments(target_ref);
CREATE INDEX IF NOT EXISTS idx_job_schedules_next ON job_schedules(enabled, next_run_at);
-- Both readers select by date: the panel folds a window, and the prior-remedy note
-- takes the most recent few. Neither ever asks for a remedy by id.
CREATE INDEX IF NOT EXISTS idx_remedies_created ON remedies(created_at);
CREATE INDEX IF NOT EXISTS idx_pr_thread_labels_answered ON pr_thread_labels(answered_at);
`;
