/**
 * The one place the tool channel's names are written down.
 *
 * Three things have to agree or the channel silently half-works: the key under
 * `mcpServers` in a launch config, the tool names {@link buildTools} exposes, and
 * the `mcp__<server>__<tool>` strings passed to `--allowedTools`. Claude Code
 * derives that qualified form from the config key, so a rename in one place and
 * not the others produces a *connected* server whose every call is refused —
 * which is exactly the failure mode this module exists to make impossible.
 */

/** The key our server is registered under in a launch config. */
export const MCP_SERVER_ID = 'lubbdubb';

/**
 * Every tool we expose. Asserted against the built tool set in `test/mcpChannel.test.ts`.
 *
 * `request_permission` (issue #130 phase B) is unlike the others: an agent is not
 * told about it and never calls it directly — Claude Code invokes it through the
 * `--permission-prompt-tool` seam ({@link PERMISSION_PROMPT_TOOL}) when a tool call
 * falls through the allow-list. It still has to be in this list, and therefore in
 * {@link ALLOWED_MCP_TOOLS}, or the permission machinery's own call to it is refused
 * — the exact "connected but every call refused" trap this module exists to prevent.
 */
export const MCP_TOOL_NAMES = [
  'plan_submit',
  'escalate',
  'world_read',
  'report_finding',
  'note_progress',
  'request_permission',
] as const;

/**
 * The names as the permission layer sees them.
 *
 * **Why this is needed at all** (verified empirically against `claude` 2.1.220,
 * headless `-p` with `--permission-mode acceptEdits`): an `--mcp-config` server
 * connects without any approval step — unlike a project `.mcp.json`, which sits
 * at `pending` until a human approves it — but its *tool calls* are still
 * permission-gated, and `acceptEdits` does not cover them. Without this the
 * result is `"Claude requested permissions to use mcp__lubbdubb__…, but you
 * haven't granted it yet."` on every call, with no human at the prompt to grant
 * it. `--allowedTools` is **additive**, not restrictive — also verified: an agent
 * launched with it still uses Bash/Write normally — so this grants our tools and
 * changes nothing else.
 *
 * This is why adding a tool to {@link buildTools} without adding its name above is
 * the sharp edge of the whole module: the server still connects, `tools/list` still
 * advertises it, and every call to it is refused with nothing in the logs to say why.
 */
export const ALLOWED_MCP_TOOLS: string[] = MCP_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_ID}__${name}`);

/**
 * The qualified name passed to `claude --permission-prompt-tool` (issue #130 phase
 * B). Derived from the same server id + tool name as every grant above, so it can
 * never drift from the tool `buildTools` actually exposes.
 */
export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_ID}__request_permission`;
