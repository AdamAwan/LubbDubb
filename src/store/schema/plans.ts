export const PLAN_SCHEMA = `-- One delivery plan per issue — the planning agent's verdict. Written for *both*
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
  -- Nothing reads this. Discuss stopped being a dispatch (it deep-links the
  -- operator's own Claude Code, which amends through the plan_amend tool), and
  -- the field went with it — but the column stays: dropping one is not an
  -- additive migration, and a NOT NULL DEFAULT costs an existing database
  -- nothing.
  discussing  INTEGER NOT NULL DEFAULT 0,
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
  atoms       TEXT,                   -- JSON array of plan_atoms slugs this part carries; null = the plan predates atoms
  rationale   TEXT,                   -- why this is its own PR
  acceptance  TEXT,                   -- what makes this part done
  acceptance_met TEXT,                -- JSON array of the criteria a reviewer has confirmed
  size        TEXT,                   -- s | m | l, how big this is to review; null = unstated
  expected_kind   TEXT,               -- code | report | determination; null = unstated, reads as code
  profile     TEXT,                   -- the model profile this part runs on; null = inherit the goal's pin
  coverage    TEXT,                   -- the end-to-end area this part adds or amends coverage for; null = not a test part
  outcome_kind    TEXT,               -- what it actually produced, written at close (never for a merge)
  outcome_ref     TEXT,               -- flag:<id> | finding:<id>, optional evidence
  outcome_summary TEXT,               -- what the concluding agent found; required at close
  depends_on  TEXT NOT NULL,          -- JSON array of sibling slugs
  branch      TEXT,
  pr_number   INTEGER,
  status      TEXT NOT NULL,          -- pending | ready | dispatched | in_review | merged | concluded | blocked | retired
  blocked_reason TEXT,                -- why, while status is blocked; cleared with it
  blocked_by  TEXT,                   -- collision | declined: which of the two blockers, for readers that must tell them apart
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (plan_id, slug)
);

-- The atoms of a plan: the smallest pieces of it that could land, be reviewed and
-- be rolled back on their own. Flat, and the grouping into parts lives on
-- plan_parts.atoms rather than here, so an atom keeps its slug across a regroup.
-- A plan written before atoms existed has no rows here and reads exactly as it
-- did — nothing is backfilled, because one atom per part would put a declaration
-- in front of a reviewer that no planner ever wrote.
CREATE TABLE IF NOT EXISTS plan_atoms (
  id          TEXT PRIMARY KEY,       -- "<plan_id>:<atom slug>"
  plan_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,
  seq         INTEGER NOT NULL,       -- document order
  title       TEXT NOT NULL,
  intent      TEXT NOT NULL,          -- why this piece exists, in the planner's words
  touches     TEXT,                   -- JSON array of paths
  acceptance  TEXT,                   -- what makes this atom done; null = unstated
  depends_on  TEXT NOT NULL,          -- JSON array of sibling atom slugs
  rejected    TEXT,                   -- JSON array of {route, because}: the routes this atom did not take
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (plan_id, slug)
);

-- Every verdict a planner has submitted for one plan, oldest first. The plan row
-- is overwritten by each amendment, which is exactly why these exist: without
-- them an operator who talked a plan through for ten minutes is handed the amended
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

-- A change somebody wants made to a plan that is already *running*, held until an
-- operator answers it. The row is the whole mechanism: a plan under way is not
-- rewritten by whoever noticed it was wrong — the amended document sits here while
-- the live plan keeps scheduling, and only an accepted proposal ingests it.
--
-- The document is kept serialized rather than exploded into columns because it is
-- re-validated at apply time, by the same validatePlanDocument both transports
-- use: what was proposed and what is ingested are then the same document, and a
-- document the schema has since moved past is refused whole rather than applied
-- in halves.
CREATE TABLE IF NOT EXISTS plan_amendments (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL,
  origin_ref  TEXT NOT NULL,          -- issue:<n>, so a reader need not resolve the plan first
  document    TEXT NOT NULL,          -- JSON PlanDocument, exactly as submitted
  note        TEXT NOT NULL,          -- why the plan must change: the whole of what an operator reads
  author      TEXT NOT NULL,          -- agent | operator
  author_ref  TEXT,                   -- the agent that proposed it; null for an operator's own
  status      TEXT NOT NULL,          -- pending | applied | declined | superseded
  resolution  TEXT,                   -- what settled it, in the operator's words or the harness's
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

-- What an operator wrote back when they ticked a plan's caveats. A caveat is
-- acknowledged by a tick; the answer is the optional words beside it — a choice
-- made between the two the planner offered, or a question left for whoever picks
-- the work up. Approving with words is still an approval: these rows are written
-- at the accept and never send the plan back for a replan.
CREATE TABLE IF NOT EXISTS plan_caveat_answers (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL,
  caveat_id   TEXT NOT NULL,          -- the caveat as the proposal declared it
  label       TEXT NOT NULL,          -- what the operator was answering, kept beside the answer
  answer      TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_caveat_answers_plan ON plan_caveat_answers (plan_id);

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
  status        TEXT NOT NULL,      -- pending | accepted | rejected | withdrawn
  action        TEXT NOT NULL,      -- JSON: the validated action, run verbatim on accept
  note          TEXT,
  decided_by    TEXT,               -- human | stack_landing (| auto_send, historical)
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

`;
