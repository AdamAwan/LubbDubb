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
  'request_human_task',
  'note_progress',
  'request_permission',
  'link_ticket',
  'conclude_work',
  'assess_issue',
  'conclude_part',
  'assay_issue',
  'scratch_append',
  'scratch_read',
  'retro_submit',
  'open_pr',
  'validation_amend',
  'validation_report',
  'report_remedy',
  'raise',
  'knowledge_propose',
  'knowledge_ask',
  'knowledge_notice',
  'knowledge_contradict',
] as const;

/**
 * One advertised tool name.
 *
 * The tool registry in `tools.ts` is a `Record` over this, so the list above and
 * the modules under `tools/` are checked against each other at compile time: a
 * name here with no module fails to build, and a module cannot name itself
 * something this list never granted.
 */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

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
 * The desktop channel's tools — a separate, much shorter list, and separate on
 * purpose.
 *
 * The operator's own Claude Code connects to a *different* socket with a
 * long-lived credential and no dispatch behind it, so it gets read a plan, argue
 * with it, get the application up, take one check, report what you saw, and
 * nothing else. Writing that as
 * its own list rather than as a filter over {@link MCP_TOOL_NAMES} is what makes
 * the narrowing structural: `src/mcp/desktopTools.ts` is a `Record` over exactly
 * this, and there is no code path from a desktop connection to `buildTools`.
 *
 * `validation_report` appears in both lists and is two different tools. They
 * share the schema and the store writes; what differs is where the check comes
 * from — the fleet's from the origin it was dispatched on, this one from what the
 * session claimed — and neither can be reached from the other's transport.
 *
 * `plan_amend` is deliberately **not** a second `plan_submit`. It writes the same
 * document through the same ingestion, but a shared name would make it the trap
 * above without the warning: an edit to "the plan tool" that silently reaches one
 * channel. A different name on each side is the whole of the defence, and the
 * document schema they genuinely do share is one export
 * (`src/mcp/planDocumentSchema.ts`) rather than two literals.
 *
 * `local_run` is the one tool here with no goal in it and nothing to write. It
 * answers "how does this project start on this machine", which is the question a
 * session has to settle before it can carry out most checks — and the reason it
 * is not a field on `validation_read` is that `validation_read` refuses a goal
 * with no checks, which is exactly the goal somebody most often wants to look at.
 *
 * No `ALLOWED_MCP_TOOLS` equivalent: the fleet's grants exist because nobody is
 * at the prompt to approve a call. Here somebody is, and it is their own machine.
 */
export const DESKTOP_TOOL_NAMES = [
  'validation_read',
  'validation_claim',
  'validation_report',
  'plan_read',
  'plan_amend',
  'local_run',
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

/**
 * The qualified name passed to `claude --permission-prompt-tool` (issue #130 phase
 * B). Derived from the same server id + tool name as every grant above, so it can
 * never drift from the tool `buildTools` actually exposes.
 */
export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_ID}__request_permission`;
