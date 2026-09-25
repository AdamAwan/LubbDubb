export const WORK_SCHEMA = `
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

-- Recurring briefs: the prompt an operator wants queued on a cron schedule.
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

-- Images an operator attached to a brief (issue #249). The bytes live on disk
-- under attachmentRoot; this row is the record of what they are and where.
--
-- Keyed on target_ref, not on a job id, because what an attachment belongs to
-- outlives the row it arrived with: a code brief becomes a desk *filing* job
-- and then a ticket, and the image has to follow the goal rather than the job.
-- While it is a brief the ref is job:<id>.
--
-- Nothing ages these out. Attachments live as long as what they are attached to,
-- so a plan written days later — and the retrospective after it — can still refer
-- back to the screenshot the goal started as. The one deletion is a brief
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

-- Goals the operator has marked a priority. One row per flagged goal, keyed on
-- its issue:<n> origin; presence is the whole value, so there is no rank and no
-- ordering among flagged goals (the pipeline order decides that, per goal).
--
-- Deliberately not pruned the way priority_overrides is. An override arranges one
-- pulse's queue and is meaningless once its origin stops being ranked; this is a
-- standing statement about a goal, and a goal with nothing queued — waiting on a
-- human, on a review, on a base — is exactly when it must survive. It is cleared
-- by the operator and by nothing else.
-- Operator overrides of which model profile a queued dispatch runs on. One row
-- per candidate origin, on exactly the terms priority_overrides is
-- kept on: keyed on the stable origin because the queue is a per-pulse
-- projection, and pruned by the same last_seen_at sweep once the harness stops
-- tracking that origin. A separate table rather than a column on
-- priority_overrides because the two statements are independent — an operator who
-- re-orders a row has said nothing about what it should run on, and one row
-- carrying both would make clearing either one a read-modify-write.
CREATE TABLE IF NOT EXISTS profile_overrides (
  origin       TEXT PRIMARY KEY,
  profile      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_priorities (
  origin     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Features an operator has paused: work under them is not picked up, and the
-- board draws them faded. A row is the whole of the statement — there is no
-- expiry, because a pause ends when the operator says so and a clock that
-- un-pauses on its own would put a feature back on the fleet unannounced.
--
-- Deliberately not a tracker label. The watch tag says whether an item is the
-- fleet's work at all and cascades onto every child; taking it off a paused
-- Feature would strip the children's tags and lose the operator's own tagging on
-- the way back. A pause leaves every tag exactly as it was.
CREATE TABLE IF NOT EXISTS goal_pauses (
  origin     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
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
  resumed_at     TEXT,
  -- How many times the harness has re-attached to this agent after its process
  -- died mid-run (issue #318). A budget, not an observation: it bounds the
  -- automatic resume so a claude that dies on every launch settles as failed
  -- instead of relaunching forever. On the row rather than in memory because
  -- spawn/resume reuse one row across restarts, and an in-memory counter would
  -- refill on every boot. Distinct from resumed_at above, which is about a park
  -- and is cleared whenever one is answered.
  resume_attempts INTEGER
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

-- Why the fleet had to come back to a pull request, and what settled it: one row
-- per CI failure or review round an agent answered, written by that agent through
-- the report_remedy tool.
--
-- A record, not a verdict. Nothing gates on a row here, no dispatch rule reads the
-- table, and a pull request goes green whether or not one was filed — the two
-- readers are the Causes reading on the Yield panel and the prior-remedy note a
-- later dispatch on the same check carries.
--
-- kind, pr_number and checks are all resolved from the caller's credential (its
-- task's origin and ci_checks) rather than from arguments, which is what makes the
-- counts worth anything: a kind an agent could assert is a column reporting
-- whatever each agent took it to mean.
--
-- Its own table rather than columns on tasks: one run can settle several reds and
-- one red can take several runs, so the two do not share a key, and a nullable
-- cause on every task row would make "no remedy filed" and "not that kind of task"
-- indistinguishable.
CREATE TABLE IF NOT EXISTS remedies (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,        -- ci | review
  origin_ref TEXT NOT NULL,        -- pr:<n>:ci | pr:<n>:comments
  pr_number  INTEGER NOT NULL,
  cause      TEXT NOT NULL,        -- what was wrong (see RemedyCause)
  guard      TEXT NOT NULL,        -- what would have caught it (see RemedyGuard)
  summary    TEXT NOT NULL,        -- one line: what was wrong, what fixed it
  checks     TEXT,                 -- JSON array of check names, from the task; null for a review remedy
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
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

-- What the operator has told the fleet to do on a goal, in their own words. Not a
-- verdict and not keyed like one: a conclusion is one overwritten row per issue,
-- so a second instruction written while the first was still outstanding would
-- silently replace it. These accumulate instead, and every one still standing is
-- appended to every dispatch on the goal.
--
-- settled_at is the whole lifecycle: an agent's conclude_work settles the ones it
-- was working under, and the operator can withdraw one. A settled row is kept
-- rather than deleted so the trail of what was asked for survives the asking.
CREATE TABLE IF NOT EXISTS issue_instructions (
  id         TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,         -- "issue:12", always the whole goal
  text       TEXT NOT NULL,         -- the operator's words, verbatim
  created_at TEXT NOT NULL,
  settled_at TEXT                   -- null while it stands
);
CREATE INDEX IF NOT EXISTS idx_issue_instructions_origin ON issue_instructions(origin_ref);

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

-- Whether an issue's goal text can be acted on at all — the goal appraisal's verdict,
-- cast before anything is dispatched against it (issue #158). Written for BOTH
-- outcomes, or the appraiser re-runs on the same issue every cycle; only 'unclear'
-- holds pickup.
--
-- goal_ref fingerprints the text that was judged. An appraisal is a verdict about a
-- *text*, so it stops standing the moment the text differs — which is how a ticket
-- edited after a failed appraisal is re-appraised without the harness having to have
-- witnessed the edit. A missing row is 'not appraised', which holds nothing: that is
-- what makes a crashed or capped appraiser fail open to ordinary pickup.
CREATE TABLE IF NOT EXISTS issue_appraisals (
  origin_ref  TEXT PRIMARY KEY,     -- "issue:12"
  verdict     TEXT NOT NULL,        -- workable | unclear
  summary     TEXT NOT NULL,
  missing     TEXT,                 -- JSON list: what the author has to add, one question per entry
  goal_ref    TEXT NOT NULL,        -- fingerprint of the title+body judged
  by          TEXT NOT NULL,        -- appraiser | operator
  proposed_profile    TEXT,         -- the model profile the appraiser proposed for this goal's work
  profile_answered_at TEXT,         -- null while that proposal is waiting on a human (the gate)
  -- Where the goal belongs on the backlog, proposed by the same appraiser. Neither
  -- holds anything: whether the question still stands is derived from the live work
  -- item, and only the operator's "does not apply" is stored.
  proposed_parent       INTEGER,    -- the container work item it should hang off
  parent_settled_at   TEXT,       -- when the operator answered that question
  proposed_area_path    TEXT,       -- the classification node it should sit on
  area_path_settled_at TEXT,      -- when the operator answered that one
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
  pad_ref           TEXT NOT NULL,    -- "issue:12", or "pr:42" for the agents working a pull request
  author_origin_ref TEXT NOT NULL,    -- "issue:12:part:schema", "pr:42:ci"
  agent_id          TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  topic             TEXT,             -- optional scannable tag
  note              TEXT NOT NULL,
  decision          TEXT,             -- JSON PadDecision on a fork; null on an ordinary note
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

`;
