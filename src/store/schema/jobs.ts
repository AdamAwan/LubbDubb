export const JOBS_SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE INDEX IF NOT EXISTS idx_job_attachments_target ON job_attachments(target_ref);
`;
