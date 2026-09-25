export const RATE_LIMITS_SCHEMA = `
-- The account's Claude usage windows, as one row (id is pinned to 1).
--
-- Read off the CLI's own rate_limit_event on the stream transport, which every
-- live agent receives — so this is the fleet's single answer to "how much of the
-- five hours is spent", not a per-agent figure. captured_at dates it, because a
-- reading only arrives when an agent takes a turn: an idle fleet's is stale, and
-- the cockpit says so rather than pretending otherwise.
--
-- Each window is independently nullable: API-key auth carries no windows at all,
-- and an older CLI carries only some.
CREATE TABLE IF NOT EXISTS account_rate_limits (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  five_hour_used_percentage REAL,
  five_hour_resets_at       TEXT,
  seven_day_used_percentage REAL,
  seven_day_resets_at       TEXT,
  captured_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_readings (
  captured_at               TEXT PRIMARY KEY,
  five_hour_used_percentage REAL,
  five_hour_resets_at       TEXT,
  seven_day_used_percentage REAL,
  seven_day_resets_at       TEXT
);
`;
