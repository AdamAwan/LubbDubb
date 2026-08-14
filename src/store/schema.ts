/** SQL schema for the LubbDubb store. Applied idempotently on boot. */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  branch      TEXT,
  origin_ref  TEXT,
  origin_title    TEXT,
  origin_summary  TEXT,
  dispatch_reason TEXT,
  status      TEXT NOT NULL,
  agent_id    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Operator-launched jobs: prompts queued from the cockpit that the dispatcher
-- drains (ahead of world-driven rules) into agents. A durable queue that lets a
-- manual request wait for a free slot when the fleet is at capacity.
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  branch     TEXT,
  status     TEXT NOT NULL,
  -- The origin this job stands in for, when it redoes work that had one of its
  -- own (a requeued crash). Null for the ordinary operator job.
  origin_ref TEXT,
  task_id    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Recurring blueprints: the prompt an operator wants queued on a cron schedule.
--
-- Intent, not work. A firing writes an ordinary jobs row, so everything
-- downstream of the queue is unchanged — this table only ever says what to queue
-- and when. next_run_at is the whole of the scheduling state: it is recomputed
-- from the clock at each firing rather than from the slot that fired, so a
-- harness that was off for a week queues one job rather than seven.
CREATE TABLE IF NOT EXISTS job_schedules (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  cron          TEXT NOT NULL,        -- five fields, read in the harness's local timezone
  enabled       INTEGER NOT NULL,     -- 0/1
  next_run_at   TEXT,                 -- null while disabled, or when the expression never matches again
  last_fired_at TEXT,
  last_job_id   TEXT,                 -- the job the last firing created; how the next pulse asks if it is still going
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Images an operator attached to a blueprint (issue #249). The bytes live on disk
-- under attachmentRoot; this row is the record of what they are and where.
--
-- Keyed on target_ref, not on a job id, because what an attachment belongs to
-- outlives the row it arrived with: a code blueprint becomes a desk *filing* job
-- and then a ticket, and the image has to follow the goal rather than the job.
-- While it is a blueprint the ref is job:<id>.
--
-- Nothing ages these out. Attachments live as long as what they are attached to,
-- so a plan written days later — and the retrospective after it — can still refer
-- back to the screenshot the goal started as. The one deletion is a blueprint
-- cancelled before it filed, which nothing downstream can want.
CREATE TABLE IF NOT EXISTS job_attachments (
  id         TEXT PRIMARY KEY,
  target_ref TEXT NOT NULL,          -- "job:<id>"
  idx        INTEGER NOT NULL,       -- position in the operator's list; also the file's stem
  label      TEXT NOT NULL,          -- the operator's filename, display only
  mime       TEXT NOT NULL,          -- sniffed from the bytes, never client-declared
  bytes      INTEGER NOT NULL,
  path       TEXT NOT NULL,          -- absolute; what an agent is handed
  created_at TEXT NOT NULL,
  UNIQUE (target_ref, idx)
);

-- Operator priority overrides for the "Up next" queue (issue #128). One row per
-- overridden candidate origin; rank (ascending, 0 = "do this next") re-orders
-- the dispatcher's ranking. Keyed on the stable origin so it survives pulses and
-- restarts even though the queue is a per-pulse projection. last_seen_at is
-- bumped each pulse the origin is still tracked, so an override for work the
-- harness has stopped tracking is pruned rather than lingering forever.
CREATE TABLE IF NOT EXISTS priority_overrides (
  origin       TEXT PRIMARY KEY,
  rank         INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  status         TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  pid            INTEGER,
  waiting_reason TEXT,
  -- Claude Code session id, chosen up front so the agent can be resumed
  -- (claude --resume <id>) in its original worktree after a server restart.
  session_id     TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  -- Cumulative Claude usage from the stream runtime's result events (issue #60).
  -- Null for runtimes that report none (PTY).
  cost_usd       REAL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  num_turns      INTEGER,
  -- The agent's own one-line answer to "what are you doing right now" (the
  -- note_progress tool). A *current value*, overwritten on each call, not a
  -- stream: the audit trail already exists in the transcript, where every call
  -- appears as a tool use. What did not exist is a cheap current reading, so
  -- that is the only thing stored. noted_at dates the note for display and is
  -- deliberately never read as evidence the agent is alive — see src/mcp/progress.ts.
  note           TEXT,
  noted_at       TEXT,
  -- When this agent was last observed doing work *after* it parked on a human
  -- (issue: stale "needs you" alerts). An observation about the park, not a
  -- status: the escalate tool returns immediately and only *asks* the agent to
  -- wait, so a model that carries on leaves the row saying waiting while it is
  -- plainly working. Deliberately does not un-park -- see AgentManager.noteResumed.
  resumed_at     TEXT
);

-- Timestamped per-report cost deltas (not cumulative), so account-level rolling
-- usage windows (5h / 7d) are a plain SUM over the window (issue #60).
CREATE TABLE IF NOT EXISTS usage_events (
  agent_id TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  at       TEXT NOT NULL
);

-- Artifacts an agent surfaced to the cockpit mid-run via the flag sentinel
-- (a design doc, a report, a link). Deduped per agent by ref so an evolving doc
-- refreshes in place; created_at tracks the most recent flag of that ref.
CREATE TABLE IF NOT EXISTS agent_flags (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  ref        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, ref)
);

-- Every file an agent wrote, captured by the file-events PostToolUse hook (not
-- the flag sentinel). Deduped per agent by path; the promoted flag marks the ones
-- also surfaced as an artifact chip (a report/doc, per classifyArtifact).
CREATE TABLE IF NOT EXISTS agent_files (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  tool       TEXT,
  promoted   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, path)
);

-- Things agents noticed that were not their own task (the report_finding tool):
-- duplicates, work blocked on something outside the repo, out-of-scope discoveries.
-- Attribution is structural — agent_id/task_id/origin_ref come from the caller's
-- credential, never from an argument. A finding is a claim, not work: it stays
-- 'open' until an operator promotes it into a job (job_id), dismisses it, or has
-- it filed as a tracker ticket (also a job, then ticket_ref via link_ticket).
CREATE TABLE IF NOT EXISTS findings (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  origin_ref TEXT,
  kind       TEXT NOT NULL,          -- duplicate | blocked | out_of_scope
  ref        TEXT,                   -- the world item it is about ("issue:41"), if any
  summary    TEXT NOT NULL,          -- the claim, one line (validation refuses a newline)
  where_at   TEXT,                   -- what locates it: file and line, package, service
  detail     TEXT,                   -- the evidence, markdown
  status     TEXT NOT NULL,          -- open | promoted | dismissed | filing | filed
  job_id     TEXT,
  ticket_ref TEXT,                   -- the ticket it was filed as ("issue:314"), once created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Work only a person can do (the request_human_task tool, or an operator filing
-- one from the cockpit). Not an escalation: nothing is blocked on an open socket,
-- no agent is parked, and the row outlives every agent and every restart.
--
-- part_id is the only way one of these ever holds work off the fleet, and that is
-- deliberate: a plan part declared expected_kind='human' is backed by exactly one
-- of these rows, and the part is the scheduling node that depends_on and the
-- reconciler's readiness pass already understand. A standalone human task blocks
-- nothing at all.
--
-- agent_id/task_id/origin_ref come from the caller's credential, never from an
-- argument; all three are null for an operator-filed task, which is how the two
-- arms are told apart without a requested_by column that could disagree with them.
CREATE TABLE IF NOT EXISTS human_tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,        -- the ask, one line (validation refuses a newline)
  detail      TEXT,                 -- what to do and how to know it is done, markdown
  origin_ref  TEXT,                 -- the work it belongs to ("issue:12", "issue:12:part:schema")
  part_id     TEXT,                 -- the plan part this task *is*, when a planner declared one
  kind        TEXT NOT NULL DEFAULT 'ask', -- ask | close_out (the harness's own, which it also settles)
  agent_id    TEXT,                 -- the requesting agent, or null when an operator filed it
  task_id     TEXT,
  status      TEXT NOT NULL,        -- open | done | declined
  resolution  TEXT,                 -- the operator's note; required on declined
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT,
  dismissed_at TEXT       -- when the operator cleared the settled row off the bench; never set while open
);

-- Whether an issue is finished, as declared by the agent that worked it (the
-- conclude_work tool) or toggled by an operator. Keyed on the issue origin, not
-- on an agent: a conclusion belongs to the issue and outlives every agent that
-- touched it, including across a replan. One row per issue, overwritten per
-- declaration — the standing verdict is a lookup, not a fold over history. A
-- missing row is 'undeclared', which is a distinct answer from 'more_work' and
-- is why rule work-item-back-to-pickup stops bouncing a reviewed item back to pickup on silence.
CREATE TABLE IF NOT EXISTS issue_conclusions (
  origin_ref TEXT PRIMARY KEY,      -- "issue:12"
  verdict    TEXT NOT NULL,         -- done | more_work
  note       TEXT NOT NULL,
  by         TEXT NOT NULL,         -- agent | assessor | operator
  agent_id   TEXT,                  -- null for an operator toggle
  task_id    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The harness's own park: an issue the assessor judged delivered, or the operator
-- marked so directly. Weaker than the tracker's 'closed' and reversible — its only
-- effect is to stop pickup, filling the gap where rule work-item-in-review's review-state hold
-- cannot reach because the provider has no review state (GitHub).
--
-- A separate table from issue_conclusions rather than a third verdict on it: a
-- conclusion is declared once and gates nothing, while this is re-read by the
-- pickup gate every pulse and stops standing when the world moves. The two are
-- mutually exclusive — writing either clears the other.
CREATE TABLE IF NOT EXISTS issue_deliveries (
  origin_ref TEXT PRIMARY KEY,      -- "issue:12"
  summary    TEXT NOT NULL,         -- one line: the verdict and what decided it
  detail     TEXT,                  -- the account behind it, markdown; null if there was none
  by         TEXT NOT NULL,         -- assessor | operator
  agent_id   TEXT,                  -- null for an operator verdict
  task_id    TEXT,
  decided_at TEXT NOT NULL,         -- what world signal is measured against
  updated_at TEXT NOT NULL
);

-- The assessor's negative verdict: the issue was worked and the goal is not
-- reached (issue #159). The mirror of issue_deliveries and deliberately NOT a
-- column on it — that table's every reader is a pickup gate, and this row gates
-- nothing. One row per issue, overwritten per assessment; mutually exclusive with
-- a delivery, enforced in the store.
--
-- The cause column is what makes it routable: three distinct failures wear one
-- face, and routing all three to a replan re-decomposes plans whose shape was
-- fine. It is declared by the assessor rather than derived, for conclude_part's
-- reason, and it is NULLABLE — an issue with no plan has no decomposition to be
-- wrong about, so "the work is just not finished" names nothing and routes to
-- nothing. That is the absence of a value rather than a fourth member, for the
-- reason 'undeclared' is not a stored conclusion verdict.
CREATE TABLE IF NOT EXISTS issue_shortfalls (
  origin_ref TEXT PRIMARY KEY,      -- "issue:12"
  cause      TEXT,                  -- plan | part | goal | null (nothing to route)
  part_slug  TEXT,                  -- the part that fell short; only for cause='part'
  summary    TEXT NOT NULL,         -- one line: the verdict and what decided it
  detail     TEXT,                  -- the account behind it, markdown; null if there was none
  by         TEXT NOT NULL,         -- assessor | operator
  agent_id   TEXT,                  -- null for an operator verdict
  task_id    TEXT,
  decided_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Whether an issue's goal text can be acted on at all — the goal assay's verdict,
-- cast before anything is dispatched against it (issue #158). Written for BOTH
-- outcomes, or the assayer re-runs on the same issue every cycle; only 'unclear'
-- holds pickup.
--
-- goal_ref fingerprints the text that was judged. An assay is a verdict about a
-- *text*, so it stops standing the moment the text differs — which is how a ticket
-- edited after a failed assay is re-assayed without the harness having to have
-- witnessed the edit. A missing row is 'not assayed', which holds nothing: that is
-- what makes a crashed or capped assayer fail open to ordinary pickup.
CREATE TABLE IF NOT EXISTS issue_assays (
  origin_ref  TEXT PRIMARY KEY,     -- "issue:12"
  verdict     TEXT NOT NULL,        -- workable | unclear
  summary     TEXT NOT NULL,
  goal_ref    TEXT NOT NULL,        -- fingerprint of the title+body judged
  by          TEXT NOT NULL,        -- assayer | operator
  agent_id    TEXT,                 -- null for an operator verdict
  task_id     TEXT,
  comment_ref TEXT,                 -- the one living comment on the ticket, edited in place
  decided_at  TEXT NOT NULL,        -- what world signal is measured against
  updated_at  TEXT NOT NULL
);

-- The shared per-issue scratchpad: what the agents working one goal leave for
-- whoever works it next, and for the retrospective written at the end.
--
-- Append-only by design. maxConcurrentPartsPerIssue permits concurrent part
-- agents, so a pad shaped as one mutable document would have them overwrite each
-- other with no merge anywhere — the silent loss detectFileOverlaps exists to
-- expose, reintroduced deliberately. Per-agent sections would avoid the clobber and
-- let an agent quietly rewrite its own history, and *when* something was learned is
-- half of what a retrospective is reading for. Attribution is written from the
-- credential, never from an argument (see padOriginFor).
CREATE TABLE IF NOT EXISTS scratch_entries (
  id                TEXT PRIMARY KEY,
  pad_ref           TEXT NOT NULL,    -- always "issue:12"
  author_origin_ref TEXT NOT NULL,    -- "issue:12:part:schema"
  agent_id          TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  topic             TEXT,             -- optional scannable tag
  note              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scratch_pad ON scratch_entries (pad_ref, created_at);

-- The run's own post-mortem: one document per goal, written after it was
-- delivered. What shipped, and what came out of the process of shipping it.
--
-- A fresh table rather than columns on issue_conclusions, because the two promise
-- different things: a conclusion is a verdict a gate re-reads every pulse, and this
-- is prose nothing branches on. The document lives here rather than being surfaced
-- as an artifact chip for plans.document's reason — GET /artifacts/:id serves out of
-- the writing agent's worktree, which the reap removes, so a write-up surfaced that
-- way 404s exactly when it becomes worth reading.
CREATE TABLE IF NOT EXISTS retrospectives (
  origin_ref TEXT PRIMARY KEY,        -- "issue:12"
  summary    TEXT NOT NULL,           -- the one line an operator reads first
  document   TEXT NOT NULL,           -- markdown, trimmed at write time rather than refused
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One delivery plan per issue — the planning agent's verdict. Written for *both*
-- outcomes (one pull request as much as a decomposition), so the planner never
-- re-runs on the same issue. The graph lives here and nowhere else: it is
-- scheduling intent, which has no home in the target repository.
--
-- The status is the plan's life and nothing else. Which shape it is being
-- delivered in is read off plan_parts — no live parts is the single-PR arm. It was
-- a 'single' status until that made shape and life exclusive; absorbSinglePlanStatus
-- carries those rows over.
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  origin_ref  TEXT NOT NULL UNIQUE,   -- "issue:12"
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,          -- planning | awaiting_approval | active | complete | abandoned
  diagnosis   TEXT,                   -- what is actually wrong: the root cause, on work that has one
  approach    TEXT,                   -- what is going to be done about it
  reason      TEXT,                   -- the planner's justification for its verdict — why this shape
  risks       TEXT,                   -- what could go wrong with this split
  out_of_scope TEXT,                  -- what the planner deliberately left out
  alternatives TEXT,                  -- what was considered and rejected, and why
  open_questions TEXT,                -- what the planner is least sure about
  verification TEXT,                  -- how anyone knows the whole thing worked
  evidence    TEXT,                   -- JSON array of {path, line, note}: where the diagnosis comes from
  document    TEXT,                   -- the full narrative, markdown
  discussing  INTEGER NOT NULL DEFAULT 0,  -- an operator is arguing with a planner about it
  status_comment_ref TEXT,            -- provider comment id, edited in place
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Parts of a multi-PR plan, and the record of which shape the plan is: no live
-- rows here is the single-PR arm. The slug is author-chosen
-- and stable, so an amended plan merges onto these rows rather than wiping them —
-- in-flight parts keep their branch and PR across a replan.
CREATE TABLE IF NOT EXISTS plan_parts (
  id          TEXT PRIMARY KEY,       -- "<plan_id>:<part slug>"
  plan_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  scope       TEXT NOT NULL,          -- files/areas this part owns, for the prompt
  touches     TEXT,                   -- JSON array of paths: the same claim, checkable against what was written
  rationale   TEXT,                   -- why this is its own PR
  acceptance  TEXT,                   -- what makes this part done
  acceptance_met TEXT,                -- JSON array of the criteria a reviewer has confirmed
  size        TEXT,                   -- s | m | l, how big this is to review; null = unstated
  expected_kind   TEXT,               -- code | report | determination; null = unstated, reads as code
  outcome_kind    TEXT,               -- what it actually produced, written at close (never for a merge)
  outcome_ref     TEXT,               -- flag:<id> | finding:<id>, optional evidence
  outcome_summary TEXT,               -- what the concluding agent found; required at close
  depends_on  TEXT NOT NULL,          -- JSON array of sibling slugs
  branch      TEXT,
  pr_number   INTEGER,
  status      TEXT NOT NULL,          -- pending | ready | dispatched | in_review | merged | concluded | blocked | retired
  blocked_reason TEXT,                -- why, while status is blocked; cleared with it
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (plan_id, slug)
);

-- Every verdict a planner has submitted for one plan, oldest first. The plan row
-- is overwritten by each amendment, which is exactly why these exist: without
-- them an operator who discussed a plan for ten minutes is handed the amended
-- decomposition whole, with nothing anywhere saying which two parts moved.
--
-- The record is of what was *proposed*, not of what the store made of it: a part
-- the amendment dropped but which kept running (because work had started) is
-- absent here and live on the plan, and both readings are true.
CREATE TABLE IF NOT EXISTS plan_revisions (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,       -- 1-based; v1 is the first verdict ever ingested
  verdict     TEXT NOT NULL,          -- single | parts, as submitted
  narrative   TEXT NOT NULL,          -- JSON PlanNarrative: the plan-level prose of this verdict
  parts       TEXT NOT NULL,          -- JSON PlanPartInput[]: the parts as declared, in document order
  at          TEXT NOT NULL,
  UNIQUE (plan_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_transcripts (
  agent_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  chunk      TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);

CREATE TABLE IF NOT EXISTS escalations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  context     TEXT NOT NULL,
  agent_id    TEXT,
  task_id     TEXT,
  response    TEXT,
  created_at  TEXT NOT NULL,
  answered_at TEXT
);

-- Acts a human was asked to authorize, and what they said (issue #109). A *fresh*
-- table rather than columns on escalations, for two reasons that outlast the
-- migration cost: an escalation is answered once with free text and is done,
-- whereas a proposal carries a typed verdict a rule reads on every pulse — and
-- the gate keys on ref, which is a column only a proposal has. Widening
-- escalations would have given every existing question five permanently-null
-- decision columns and no way to tell "not a proposal" from "not yet decided".
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,      -- reply_draft | merge
  ref           TEXT NOT NULL,      -- "pr:42:merge" — the act's subject, what the gate keys on
  status        TEXT NOT NULL,      -- pending | accepted | rejected
  action        TEXT NOT NULL,      -- JSON: the validated action, run verbatim on accept
  note          TEXT,
  decided_by    TEXT,               -- human | auto_send — the two authorities, one record
  decided_at    TEXT,
  escalation_id TEXT,
  created_at    TEXT NOT NULL
);

-- An operator's standing authorization to land a whole stack (see StackLanding).
-- Its own table rather than a proposal, because a proposal is a verdict on *one
-- formed act* and this is a verdict given before any of the acts exist: it
-- authorizes merges the harness has not proposed yet and will not propose for
-- several cycles. Filing it as a proposal would have needed a ref naming an act
-- that has no number yet, and a pending row nobody is being asked to answer.
--
-- The rungs column is the authorization and ref is not: the stack ref renames
-- itself the moment the bottom rung merges, so every lookup keys on PR numbers.
CREATE TABLE IF NOT EXISTS stack_landings (
  id         TEXT PRIMARY KEY,
  ref        TEXT NOT NULL,      -- "stack:124", as it read at the click
  rungs      TEXT NOT NULL,      -- JSON array of PR numbers, bottom-first
  status     TEXT NOT NULL,      -- standing | landed | stopped | revoked
  reason     TEXT,               -- why it stopped
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Pull requests whose merged branch has already been deleted, locally and on the
-- remote (see BranchReapStore). Keyed on the pull request rather than the branch:
-- a branch name is reusable, and a row keyed on the name would suppress the reap
-- owed to the *next* branch that wore it.
CREATE TABLE IF NOT EXISTS branch_reaps (
  pr_number INTEGER PRIMARY KEY,
  branch    TEXT NOT NULL,      -- what was deleted, for the audit trail
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
-- write. Two statuses for the reason findings has them: filing is asynchronous, so
-- 'filing' means an agent is creating it and 'filed' is the one carrying a ref.
--
-- Not a findings row: a Finding is testimony, with agent_id/task_id NOT NULL and
-- attribution taken structurally from a credential. A harness-authored row has
-- neither, and forging them is the lie structural identity exists to prevent.
CREATE TABLE IF NOT EXISTS work_item_filings (
  target_ref TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  status     TEXT NOT NULL,          -- filing | filed
  ticket_ref TEXT,                   -- the item it was filed as ("issue:314"), once created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A bug the operator raised against a story from the cockpit: they ran the thing
-- and it does not do what they expect, which is the one fact no agent on the goal
-- can derive. Keyed on the *job*, not the story, so one story can carry several
-- bugs over its life — the difference from work_item_filings above, whose target
-- key deliberately allows one filing per node.
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
-- rather than a third work_item_filings status: that row's job_id is NOT NULL
-- because a filing *is* an agent doing something, and an ignore is the operator
-- saying nothing should be. Keyed on the node, so ignoring twice is one row and
-- un-ignoring is a delete — which is what leaves the verdict exactly one
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

-- How anyone checks that the *goal* was met: the executable form of the plan's
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
  fleet_candidate INTEGER NOT NULL DEFAULT 0,  -- the planner's nomination; dispatches nothing
  candidate_why   TEXT,               -- why an agent could run it; kept only with the nomination
  actor       TEXT,                   -- human | fleet — the operator's hand-over; never the planner's
  handback_note TEXT,                 -- why the fleet gave it back; cleared by the next reading
  claimed_by  TEXT,                   -- desktop session holding this check; one live claim harness-wide
  claimed_at  TEXT,                   -- when it was taken; a claim past desktopClaimMinutes holds nothing
  state       TEXT NOT NULL,          -- unrun | passed | failed | waived | deferred
  result_note TEXT,                   -- the one current reading: a result, a deferral's reason, a waiver's
  result_by   TEXT,                   -- operator | agent | desktop; null while unrun
  result_at   TEXT,
  defer_until TEXT,                   -- when a deferral says it comes back; null is "not saying"
  superseded_reason TEXT,             -- set when an amendment stopped declaring it; null is live
  revision    TEXT,                   -- JSON: the wording an amendment replaced, and the reading it withdrew
  amended_at  TEXT,                   -- when an amendment last changed it; cleared by the next reading
  amend_note  TEXT,                   -- why it changed, in the amender's words
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (origin_ref, id)
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

CREATE INDEX IF NOT EXISTS idx_agent_flags_agent ON agent_flags(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_attachments_target ON job_attachments(target_ref);
CREATE INDEX IF NOT EXISTS idx_job_schedules_next ON job_schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_human_tasks_status ON human_tasks(status);
CREATE INDEX IF NOT EXISTS idx_human_tasks_part ON human_tasks(part_id);
CREATE INDEX IF NOT EXISTS idx_human_tasks_kind_origin ON human_tasks(kind, origin_ref);
CREATE INDEX IF NOT EXISTS idx_plans_origin ON plans(origin_ref);
CREATE INDEX IF NOT EXISTS idx_plan_parts_plan ON plan_parts(plan_id);
CREATE INDEX IF NOT EXISTS idx_validation_checks_goal ON validation_checks(origin_ref);
CREATE INDEX IF NOT EXISTS idx_proposals_ref ON proposals(ref);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);
CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_ref);
CREATE INDEX IF NOT EXISTS idx_work_item_filings_job ON work_item_filings(job_id);
CREATE INDEX IF NOT EXISTS idx_issue_bug_filings_origin ON issue_bug_filings(origin_ref);
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_ref);
`;
