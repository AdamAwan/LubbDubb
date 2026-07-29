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
  task_id    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  summary    TEXT NOT NULL,
  status     TEXT NOT NULL,          -- open | promoted | dismissed | filing | filed
  job_id     TEXT,
  ticket_ref TEXT,                   -- the ticket it was filed as ("issue:314"), once created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Whether an issue is finished, as declared by the agent that worked it (the
-- conclude_work tool) or toggled by an operator. Keyed on the issue origin, not
-- on an agent: a conclusion belongs to the issue and outlives every agent that
-- touched it, including across a replan. One row per issue, overwritten per
-- declaration — the standing verdict is a lookup, not a fold over history. A
-- missing row is 'undeclared', which is a distinct answer from 'more_work' and
-- is why rule 3b stops bouncing a reviewed item back to pickup on silence.
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
-- effect is to stop pickup, filling the gap where rule 3b's review-state hold
-- cannot reach because the provider has no review state (GitHub).
--
-- A separate table from issue_conclusions rather than a third verdict on it: a
-- conclusion is declared once and gates nothing, while this is re-read by the
-- pickup gate every pulse and stops standing when the world moves. The two are
-- mutually exclusive — writing either clears the other.
CREATE TABLE IF NOT EXISTS issue_deliveries (
  origin_ref TEXT PRIMARY KEY,      -- "issue:12"
  summary    TEXT NOT NULL,
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
  summary    TEXT NOT NULL,
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

-- One delivery plan per issue — the planning agent's verdict. Written for *both*
-- outcomes ('single' as much as a decomposition), so the planner never re-runs on
-- the same issue. The graph lives here and nowhere else: it is scheduling intent,
-- which has no home in the target repository.
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  origin_ref  TEXT NOT NULL UNIQUE,   -- "issue:12"
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,          -- planning | single | active | complete | abandoned
  reason      TEXT,                   -- the planner's justification for its verdict
  risks       TEXT,                   -- what could go wrong with this split
  out_of_scope TEXT,                  -- what the planner deliberately left out
  document    TEXT,                   -- the full narrative, markdown
  discussing  INTEGER NOT NULL DEFAULT 0,  -- an operator is arguing with a planner about it
  status_comment_ref TEXT,            -- provider comment id, edited in place
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Parts of a multi-PR plan. Empty for a 'single' plan. The slug is author-chosen
-- and stable, so an amended plan merges onto these rows rather than wiping them —
-- in-flight parts keep their branch and PR across a replan.
CREATE TABLE IF NOT EXISTS plan_parts (
  id          TEXT PRIMARY KEY,       -- "<plan_id>:<part slug>"
  plan_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  scope       TEXT NOT NULL,          -- files/areas this part owns, for the prompt
  rationale   TEXT,                   -- why this is its own PR
  acceptance  TEXT,                   -- what makes this part done
  expected_kind   TEXT,               -- code | report | determination; null = unstated, reads as code
  outcome_kind    TEXT,               -- what it actually produced, written at close (never for a merge)
  outcome_ref     TEXT,               -- flag:<id> | finding:<id>, optional evidence
  outcome_summary TEXT,               -- what the concluding agent found; required at close
  depends_on  TEXT NOT NULL,          -- JSON array of sibling slugs
  branch      TEXT,
  pr_number   INTEGER,
  status      TEXT NOT NULL,          -- pending | ready | dispatched | in_review | merged | concluded | blocked | retired
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (plan_id, slug)
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

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  cycle_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  detail     TEXT NOT NULL,
  -- The dispatcher rule that produced the action (see src/dispatcher/rules.ts);
  -- NULL when the decision has no rule identity (LLM dispatcher, bookkeeping).
  rule       TEXT,
  created_at TEXT NOT NULL
);

-- The FakeConnector persists its editable world here so injected events survive restarts.
CREATE TABLE IF NOT EXISTS connector_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_agent_flags_agent ON agent_flags(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_plans_origin ON plans(origin_ref);
CREATE INDEX IF NOT EXISTS idx_plan_parts_plan ON plan_parts(plan_id);
CREATE INDEX IF NOT EXISTS idx_proposals_ref ON proposals(ref);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle ON decisions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);
CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_ref);
CREATE INDEX IF NOT EXISTS idx_work_item_filings_job ON work_item_filings(job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_ref);
`;
