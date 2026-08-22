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
 * Where each tool is named to the agent that has to call it.
 *
 * Granting a tool is not telling an agent it exists: `tools/list` advertises it,
 * but a model working a task reaches for what its instructions named, and a tool
 * nothing names loses to `gh`, `az` and a hand-rolled equivalent with nothing red
 * anywhere. `open_pr` spent its first release exactly there.
 *
 * - `addendum` — nothing else names it, so {@link MCP_PROTOCOL_ADDENDUM} must.
 * - `point-of-use` — named by the prompt or the instruction that dispatches the
 *   work it belongs to, which is the better place for a tool only one kind of
 *   agent ever calls. Keeping them *out* of the addendum is what keeps it short
 *   enough to read.
 * - `superseded` — deliberately named nowhere. `raise` is the door for everything
 *   these four did, so advertising them would put six ways to file one
 *   observation in front of every agent. They stay *registered* rather than
 *   deleted because an operator's prompt override written before the intake may
 *   still name one, and unlike a `PromptId` a withdrawn tool name fails silently:
 *   the call comes back refused with nothing in the logs, on exactly the
 *   deployments that customised most.
 *
 * **This lives beside the names rather than in `test/mcpChannel.test.ts`, where it
 * was written.** `src/setup/reading.ts` reads the `superseded` half to tell an
 * operator that an override of theirs still names one, and a classification a
 * test owns is a classification production code has to keep a second copy of —
 * free to disagree with what is actually granted, silently, which is the failure
 * the whole module exists to make impossible. The test asserts *against* it
 * instead, in both directions.
 *
 * A `Record` over {@link McpToolName}, so a new tool does not compile until it has
 * been classified.
 */
export const TOOL_NAMING: Record<McpToolName, 'addendum' | 'point-of-use' | 'superseded'> = {
  // The one door. Every agent may raise, on every dispatch, so there is no single
  // prompt that could name it — which is the addendum's own criterion.
  raise: 'addendum',
  escalate: 'addendum',
  plan_submit: 'addendum',
  world_read: 'addendum',
  open_pr: 'addendum',
  note_progress: 'addendum',
  // Every agent may read the knowledge base, and it has no point of use to be named
  // at: a tool named nowhere but in `tools/list` is a tool an agent finishes without.
  knowledge_ask: 'addendum',
  // A request for a person to act rather than an observation, which is why it did
  // not fold into `raise` — and why it still needs naming.
  request_human_task: 'addendum',
  // The four `raise` replaced. Kept registered for an override that names one.
  report_finding: 'superseded',
  knowledge_propose: 'superseded',
  knowledge_notice: 'superseded',
  knowledge_contradict: 'superseded',
  // Terminal or task-scoped: the dispatch prompt names these where they are used.
  link_ticket: 'point-of-use',
  conclude_work: 'point-of-use',
  conclude_part: 'point-of-use',
  assess_issue: 'point-of-use',
  assay_issue: 'point-of-use',
  retro_submit: 'point-of-use',
  scratch_append: 'point-of-use',
  scratch_read: 'point-of-use',
  validation_report: 'point-of-use',
  validation_amend: 'point-of-use',
  report_remedy: 'point-of-use',
  // The one tool an agent is never told about: Claude Code calls it through
  // --permission-prompt-tool, so naming it would invite a call that means nothing.
  request_permission: 'point-of-use',
};

/**
 * The tools `raise` replaced, still registered and still granted.
 *
 * Derived from {@link TOOL_NAMING} rather than written out again, so the list an
 * operator is warned about cannot drift from the list that is actually granted —
 * which is the same three-way-agreement argument as {@link ALLOWED_MCP_TOOLS},
 * pointed at the reading instead of at the launch.
 *
 * → `docs/spec/26-setup.md#an-override-that-names-a-superseded-tool`
 */
export const SUPERSEDED_TOOL_NAMES: readonly McpToolName[] = MCP_TOOL_NAMES.filter(
  (name) => TOOL_NAMING[name] === 'superseded',
);

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
