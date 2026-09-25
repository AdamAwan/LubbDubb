export const PULL_REQUEST_SCHEMA = `-- Pull requests the harness has already tagged with the watch label because it
-- opened them (see PrWatchSeedStore). Stored because the live labels cannot answer
-- it: a pull request an operator has un-watched looks exactly like one never
-- reached, and re-tagging it would undo the operator's own click every pulse.
CREATE TABLE IF NOT EXISTS pr_watch_seeds (
  pr_number INTEGER PRIMARY KEY,
  branch    TEXT NOT NULL,      -- what it was tagged for, for the audit trail
  at        TEXT NOT NULL
);

-- Pull requests the harness has already linked to their work item (see
-- WorkItemLinkStore). Stored because neither the world nor the other rows here
-- answer it: an operator may delete a link they judged wrong, and re-deriving from
-- the world would write it straight back every pulse; and linkedPrNumber names only
-- the *last* pull request to cross-reference an item, so on a plan whose parts each
-- open one, the earlier parts read as unlinked however many links really exist.
CREATE TABLE IF NOT EXISTS pr_work_item_links (
  pr_number INTEGER PRIMARY KEY,
  work_item INTEGER NOT NULL,   -- what it was linked to, for the audit trail
  at        TEXT NOT NULL
);

-- How long a pull request has been sitting on a reviewer, as one watermark per PR
-- (see ReviewWaitStore). Stored because the question is about a *span* and every
-- other reading here is about an instant: no provider payload says "reviewable
-- since", and the moment a pull request became reviewable is not recoverable from
-- a later snapshot of it. Deleted the moment it stops waiting, so the table holds
-- only what is currently outstanding.
CREATE TABLE IF NOT EXISTS pr_review_waits (
  pr_number INTEGER PRIMARY KEY,
  since     TEXT NOT NULL
);

-- The fleet's own review of a pull request (see PrReviewStore): one row per pull
-- request, written by the review_report tool.
--
-- Keyed on the pull request rather than on the commit it read, because the review
-- runs once: a key that moved with the diff would be invalidated by the first fix
-- pushed after the review, and with nothing re-reviewing, the merge gate would
-- never be satisfied again. head_sha records what was in front of the reviewer
-- and gates nothing.
CREATE TABLE IF NOT EXISTS pr_reviews (
  pr_number   INTEGER PRIMARY KEY,
  head_sha    TEXT,
  verdict     TEXT NOT NULL,   -- 'clear' | 'findings'
  summary     TEXT NOT NULL,
  findings    TEXT NOT NULL,   -- JSON array of strings
  agent_id    TEXT,
  reviewed_at TEXT NOT NULL,
  -- The provider's id for the thread the findings were published into, where one
  -- went out and the provider named it. Nullable, matching the ALTER TABLE that
  -- adds it to a database from before it existed: null is what every row written
  -- then meant — nothing recorded published this review — and it needs no backfill
  -- because there is nothing to read it from.
  published_thread TEXT
);

-- How the harness decided to read a pull request: the triage's verdict, naming one
-- of the modes the project declared (see PrReviewRouteStore).
--
-- Separate from pr_reviews because the merge gate is satisfied by a pr_reviews row
-- existing: a row written early to carry a route would report the pull request as
-- reviewed by the step that only decided how to review it.
CREATE TABLE IF NOT EXISTS pr_review_routes (
  pr_number  INTEGER PRIMARY KEY,
  mode       TEXT NOT NULL,          -- empty on a skip: no mode was chosen
  -- 1 = the triage decided this pull request needs no review at all (review.allowSkip).
  -- Nullable, matching the ALTER TABLE that adds it to a database from before it
  -- existed: null is what those rows meant — routed and reviewed — so there is no
  -- backfill, and the column has one shape everywhere.
  skipped    INTEGER,
  reason     TEXT NOT NULL,
  agent_id   TEXT,
  decided_at TEXT NOT NULL
);

-- One row per pull request rule pr-split has asked about, whatever the answer.
-- The row is what stops it asking twice: a pull request wide enough to be worth a
-- look is worth exactly one look, and a 'coherent' verdict is as much a record as a
-- 'split' one. Keyed on the pull request rather than its head commit, so pushing to
-- a PR already judged coherent does not buy another assessment.
CREATE TABLE IF NOT EXISTS pr_splits (
  pr_number    INTEGER PRIMARY KEY,
  issue_number INTEGER NOT NULL,
  verdict      TEXT NOT NULL,          -- 'split' | 'coherent'
  concepts     TEXT NOT NULL,          -- JSON array of names; empty on 'coherent'
  reason       TEXT NOT NULL,
  files        INTEGER NOT NULL,       -- what the diff measured when it was read
  agent_id     TEXT,
  decided_at   TEXT NOT NULL
);

-- Pull requests a check *outside* the harness reported already reviewed (see
-- PrReviewExternalStore). Its own table rather than a pr_reviews row, because that
-- row means "the fleet read this, and here is what it found" — writing an external
-- gate as one would put a verdict in the cockpit and in the next agent's prompt
-- that nothing in this harness ever performed. Only the "reviewed" verdict lands: a
-- gate that has not passed yet may pass later, and a row for the absence of an
-- answer would freeze it into one.
CREATE TABLE IF NOT EXISTS pr_review_externals (
  pr_number INTEGER PRIMARY KEY,
  detail    TEXT NOT NULL,      -- what said so, for the audit trail
  at        TEXT NOT NULL
);

-- Review threads the operator has put back in front of the fleet (see
-- PrThreadReopenStore). A mark rather than a write to the provider: unresolving a
-- thread on GitHub reopens the reviewer's question in their inbox, where this says
-- "come back to this" to the harness — and for the common case, a thread nobody
-- resolved that the fleet merely answered last, the provider cannot express it at
-- all. Cleared by the harness's next reply into the thread, never by a timer: a
-- mark that outlived the reply would dispatch for it every pulse, forever.
CREATE TABLE IF NOT EXISTS pr_thread_reopens (
  pr_number   INTEGER NOT NULL,
  thread_id   TEXT NOT NULL,      -- the thread's root comment id, as PrComment carries it
  reopened_at TEXT NOT NULL,      -- when the operator asked; drawn beside the thread
  PRIMARY KEY (pr_number, thread_id)
);

-- One row per review-thread reply the harness actually sent (see PrReplyStore),
-- keyed by the provider's own id for the comment it created. Attribution is a
-- record, never an inference: reading it off the author marked the operator's own
-- follow-up on their own review thread as the fleet's answer, which folded to
-- PrComment.handled and dropped the comment before any rule saw it. A reply with
-- no usable ref writes no row and the thread keeps reading as work; there is no
-- backfill for replies sent before this table, because the only evidence left on
-- those is the author.
CREATE TABLE IF NOT EXISTS pr_replies_sent (
  pr_number   INTEGER NOT NULL,
  thread_id   TEXT NOT NULL,      -- the thread replied into, as PrComment carries its id
  comment_ref TEXT NOT NULL,      -- the provider's id for the comment created, as PrThreadMessage carries it
  sent_at     TEXT NOT NULL,
  PRIMARY KEY (pr_number, comment_ref)
);

-- What the agent answering a review thread said the thread was about. One row per
-- thread rather than per reply: the fleet may come back to a thread several times and
-- the count wants the thread once. How often it came back is pr_replies_sent, which
-- keeps a row per reply that left. The path is stored and the area derived from it at
-- read time, so a correction to the area rules corrects the whole back-catalogue.
CREATE TABLE IF NOT EXISTS pr_thread_labels (
  pr_number     INTEGER NOT NULL,
  thread_id     TEXT NOT NULL,
  about_comment INTEGER NOT NULL,  -- the reviewer's point was about a code comment, not the code
  changed_code  INTEGER NOT NULL,  -- the agent changed code for it, rather than defending it
  resolved      INTEGER NOT NULL,  -- the reply asked the harness to mark the thread resolved
  path          TEXT,              -- repository-relative file the thread is anchored to; null for a PR-level thread
  author        TEXT,              -- who left the thread, to tell a review bot from a person
  author_is_bot INTEGER,           -- the provider's own word at the time; null where it said nothing
  agent_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  answered_at   TEXT NOT NULL,
  PRIMARY KEY (pr_number, thread_id)
);

-- The last reading of every pull request that has left the open set (see
-- PrArchiveStore), kept for good. WorldSnapshot.closedPullRequests is a window --
-- it carries a merge for closedPrWindowMs and then forgets it -- and the goal
-- page's closed rows were drawn straight off it, so a goal's pull requests
-- disappeared from its page hours after they merged. A row here is a fact about
-- the past and never a reading of the present: nothing re-fetches it and nothing
-- acts on it. Upserted on the number, so the window re-reporting the same merge
-- every pulse refreshes the row rather than appending to it. The table is new, so
-- it needs no ColumnMigrations entry -- but a table being new once does not keep
-- it exempt, and a column added later will.
CREATE TABLE IF NOT EXISTS pr_archive (
  number        INTEGER PRIMARY KEY,
  -- The provider's own instant, NULL when it never dated the close. The sort falls
  -- back to first_seen_at so such a row still lands beside its neighbours.
  closed_at     TEXT,
  first_seen_at TEXT NOT NULL,  -- when the harness first archived it; survives every later replace
  updated_at    TEXT NOT NULL,
  snapshot      TEXT NOT NULL   -- the whole PullRequest as the world last reported it, JSON
);

-- How far the closed pull request set has actually been swept, as one row (id 1).
-- The provider asks its window back from *now*, which is a claim about wall clock
-- rather than about what the harness has seen: every close that happened while the
-- harness was down falls out of reach on the first pulse back and never comes
-- within reach again, because the window only moves forward. The retarget, the
-- branch reap, the landing sweep and the archive all lose those merges together.
-- The mark turns the window into a floor on the *read*: the next read asks from the
-- older of the window and this mark, capped by closedPrCatchUpMs so a long outage
-- is not an unbounded query. Written only after a read the provider completed, and
-- only ever forward. See src/store/prArchive.ts.
CREATE TABLE IF NOT EXISTS closed_pr_sweep (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  swept_to   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  cycle_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  detail     TEXT NOT NULL,
  -- The dispatcher rule that *proposed* the action (see src/dispatcher/rules.ts);
  -- NULL when the decision has no rule identity (bookkeeping, human-authorized acts).
  rule       TEXT,
  -- What *became* of that proposal: an admission-kind id from the same registry
  -- (branch-notify, cooldown-escalate), NULL when the proposal was admitted
  -- unchanged. Rows written before this column existed carry the outcome in
  -- rule and NULL here; the two shapes coexist and are told apart by whether
  -- this is set (see Store.migrate).
  admission  TEXT,
  created_at TEXT NOT NULL
);

-- The FakeConnector persists its editable world here so injected events survive restarts.
CREATE TABLE IF NOT EXISTS connector_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Observed world state transitions, diffed from consecutive snapshots. The
-- activity feed's backing store — the world counterpart to the decision log.
CREATE TABLE IF NOT EXISTS world_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Single-row cache of the last snapshot the harness diffed against, so a restart
-- neither blinds the diff nor floods the feed with a spurious "everything new".
CREATE TABLE IF NOT EXISTS world_baseline (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  world TEXT NOT NULL
);

-- Recorded failures (cycle exceptions, provider outages, agent crashes, route
-- 500s) — the Errors panel's backing store. See src/errorLog.ts.
CREATE TABLE IF NOT EXISTS error_events (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

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

-- A bug the operator raised against a story from the cockpit: they ran the thing
-- and it does not do what they expect, which is the one fact no agent on the goal
-- can derive. Keyed on the *job*, not the story, so one story can carry several
-- bugs over its life — the difference from work_item_filings above, whose target
-- key deliberately allows one filing per node. It still has a job because a bug is
-- still written up by a desk agent (#394 kept that arm and took the *create* off
-- it); a work item's filing has none, because nothing is dispatched for one.
--
-- The operator's report is not a column: the desk job's prompt carries it verbatim
-- and is durable, and a second copy is two records of one sentence free to drift.
CREATE TABLE IF NOT EXISTS issue_bug_filings (
  job_id     TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,          -- the story it was raised from ("issue:12")
  status     TEXT NOT NULL,          -- filing | filed
  ticket_ref TEXT,                   -- the bug it was filed as ("issue:314"), once created
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

-- One run of the harness at a goal (issue #234), from the first pulse that saw
-- work under it until the operator dismisses it.
--
-- It replaces floor_completions (#203), which recorded a *completion* and so
-- was minted only for a goal already finished while its issue was still live.
-- Two things were wrong with that. A goal nobody finished — abandoned, or its
-- ticket closed mid-flight — was never recorded at all, so there was nothing to
-- dismiss; and the row retained the *card* while ctx.world.issues still came
-- straight off the tracker, so after a close the harness could draw a goal it
-- could no longer act on. This row is what the dispatcher's issue list is
-- unioned with, so the assessor and the retrospective — both of which come
-- *after* a merge — still run once the ticket is closed.
--
-- The five snapshot columns are the issue as it last stood while live: a
-- retained run is dispatched from, so its body feeds the assessor's and the
-- retro's prompts and its labels feed every watch gate. migrate() backfills
-- this table from floor_completions and drops it — a live database holds
-- dismissals the operator has already made, and losing one resurrects a card
-- they cleared.
CREATE TABLE IF NOT EXISTS issue_runs (
  origin_ref      TEXT PRIMARY KEY,  -- "issue:12"
  issue_number    INTEGER NOT NULL,
  title           TEXT NOT NULL,     -- captured while the issue is still live
  body            TEXT NOT NULL,     -- and so is the rest of the snapshot
  labels          TEXT NOT NULL,     -- JSON array
  linked_pr       INTEGER,
  work_item_state TEXT,
  started_at      TEXT NOT NULL,     -- first pulse with work under this origin; frozen
  completed_at    TEXT,              -- first observed complete; frozen. Null while it is not
  outcome         TEXT,              -- 'judged' | 'abandoned', stamped at dismissal
  dismissed_at    TEXT,              -- null until the operator dismisses; one-way
  updated_at      TEXT NOT NULL
);

`;
