export const PR_THREAD_REOPENS_SCHEMA = `
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
`;
