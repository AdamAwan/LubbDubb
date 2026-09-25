export const MCP_CALLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_calls (
  id         TEXT PRIMARY KEY,
  -- 'fleet' or 'desktop'. Never summed across: they are different credentials,
  -- different tool sets, and validation_report is two different tools.
  channel    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  agent_id   TEXT,
  task_id    TEXT,
  -- The origin the calling agent was dispatched on, copied at write time rather
  -- than joined at read time: the task outlives nothing, but the phase reading
  -- wants the ref as it was when the call happened, and a task retargeted later
  -- would silently re-file every call it ever made under a different phase.
  origin_ref TEXT,
  ok         INTEGER NOT NULL,
  -- The refusal in the tool's own words, when it refused. Null on success.
  error      TEXT,
  duration_ms INTEGER NOT NULL,
  -- The call's arguments as JSON, and the only column here that is ever cleared.
  -- Kept so "how is this tool used" is answerable, dropped after
  -- mcpArgsRetentionDays because it is the only part of a row that is
  -- unbounded and the only part that carries issue text and code.
  args       TEXT,
  -- What args measured before it was cleared, so the reading survives the
  -- compaction that removes the text. Written at insert, never updated.
  args_bytes INTEGER NOT NULL,
  -- Whether args has been compacted away, as distinct from a call that carried
  -- no arguments at all. Two very different rows would otherwise both read as
  -- args IS NULL, and the panel would report a fortnight of empty calls.
  args_dropped INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_calls_created ON mcp_calls(created_at);

CREATE INDEX IF NOT EXISTS idx_mcp_calls_args ON mcp_calls(args_dropped, created_at);
`;
