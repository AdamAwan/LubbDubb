export const INVESTIGATIONS_SCHEMA = `
-- What a read-only investigator found about an issue carrying the investigate label,
-- before anything was planned for it. One row per issue, overwritten per investigation.
-- goal_ref fingerprints the ticket text investigated, so an edit re-arms the rule. Not a
-- verdict in the exclusion matrix: it parks nothing on its own, and the hold it feeds is
-- lifted the moment the label comes off the issue.
CREATE TABLE IF NOT EXISTS issue_investigations (
  origin_ref     TEXT PRIMARY KEY,  -- "issue:12"
  goal_ref       TEXT NOT NULL,     -- fingerprint of the title+body investigated
  by             TEXT NOT NULL,     -- the investigating agent's id
  reproduction   TEXT NOT NULL,
  root_cause     TEXT NOT NULL,
  confidence     TEXT NOT NULL,     -- high | medium | low
  locations      TEXT NOT NULL,
  blast_radius   TEXT NOT NULL,
  recommendation TEXT NOT NULL,     -- plan | close | ask (a pickup row reads as plan)
  decided_at     TEXT NOT NULL,
  resolution     TEXT,              -- null while it waits on the operator; else plan | pickup | close | ask
  resolved_at    TEXT
);

-- The issues the harness itself put the investigate label on, after a goal appraisal asked.
-- Applied once per issue, ever: an operator who takes the label off has answered, and a later
-- appraisal of a rewritten ticket must not put it back.
CREATE TABLE IF NOT EXISTS issue_investigate_labels (
  origin_ref TEXT PRIMARY KEY,  -- "issue:12"
  applied_at TEXT NOT NULL
);
`;
