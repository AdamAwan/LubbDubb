export const ISSUE_VERDICTS_SCHEMA = `
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
`;
