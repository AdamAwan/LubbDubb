export const BOT_PR_RISKS_SCHEMA = `
-- One batch of bot pull requests put in front of one desk agent to read for risk
-- (see BotPrRiskStore). Opened by BotPrRiskDesk on its schedule or on an operator's
-- press, claimed by the dispatch that starts its agent, and settled once that
-- agent's task is no longer active. The briefing is assembled once, when the run
-- opens, so a restart re-dispatches the same text rather than re-reading providers.
CREATE TABLE IF NOT EXISTS bot_pr_risk_runs (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,        -- 'pending' | 'dispatched' | 'done'
  trigger     TEXT NOT NULL,        -- 'schedule' | 'operator'
  subjects    TEXT NOT NULL,        -- JSON [{number, headSha, title}], the pull requests this run may rule on
  briefing    TEXT NOT NULL,
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  settled_at  TEXT
);

-- At most one run open at a time: a second press while one is out is refused here,
-- across a restart, rather than by a check the desk makes first.
CREATE UNIQUE INDEX IF NOT EXISTS bot_pr_risk_runs_open
  ON bot_pr_risk_runs ((1)) WHERE status IN ('pending', 'dispatched');

-- One verdict per pull request per head commit. Keyed on the head, because a bot
-- that rebases or bumps again has changed what was read, and a verdict on the old
-- head is no verdict on the new one. A head with a row here is what "seen" means.
CREATE TABLE IF NOT EXISTS bot_pr_risks (
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  risk        TEXT NOT NULL,        -- 'low' | 'medium' | 'high'
  summary     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  PRIMARY KEY (pr_number, head_sha)
);
`;
