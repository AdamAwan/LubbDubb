export const PR_ARCHIVE_SCHEMA = `
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
`;
