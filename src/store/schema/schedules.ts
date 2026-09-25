export const SCHEDULES_SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_job_schedules_next ON job_schedules(enabled, next_run_at);
`;
