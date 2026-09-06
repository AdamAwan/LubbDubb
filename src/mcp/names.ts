/**
 * The one place the tool channel's names are written down.
 *
 * Three things must agree or the channel silently half-works: the key under `mcpServers`
 * in a launch config, the tool names {@link buildTools} exposes, and the
 * `mcp__<server>__<tool>` strings passed to `--allowedTools`. Drift produces a *connected*
 * server whose every call is refused, with nothing in the logs.
 */

/** The key our server is registered under in a launch config. */
export const MCP_SERVER_ID = 'lubbdubb';

/**
 * Every tool we expose. Asserted against the built tool set in `test/mcpChannel.test.ts`.
 *
 * `request_permission` is never called by an agent — Claude Code invokes it through the
 * `--permission-prompt-tool` seam ({@link PERMISSION_PROMPT_TOOL}) — but it must still be
 * listed here, and so in {@link ALLOWED_MCP_TOOLS}, or the permission machinery's own call
 * to it is refused.
 */
export const MCP_TOOL_NAMES = [
  'plan_submit',
  'plan_correct',
  'plan_not_needed',
  'escalate',
  'world_read',
  'request_human_task',
  'note_progress',
  'request_permission',
  'link_ticket',
  'conclude_work',
  'assess_issue',
  'conclude_part',
  'appraise_issue',
  'scratch_append',
  'scratch_read',
  'retro_submit',
  'feature_summary',
  'sequence_submit',
  'open_pr',
  'reply_to_review',
  'validation_amend',
  'validation_report',
  'local_validation_plan',
  'local_run_read',
  'local_validation_report',
  'watch_declare',
  'review_report',
  'review_route',
  'report_remedy',
  'raise',
  'review_pack_submit',
  'review_pack_check',
] as const;

/**
 * One advertised tool name. The registry in `tools.ts` is a `Record` over this, so a name
 * with no module fails to build and a module cannot name itself something never granted.
 */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Where each tool is named to the agent that has to call it: `addendum` means nothing else
 * names it so {@link MCP_PROTOCOL_ADDENDUM} must; `point-of-use` means the dispatch prompt
 * for the work it belongs to names it. A tool nothing names is never reached, with nothing red.
 * Lives beside the names rather than in a test because the Insights MCP tab reads it too.
 * → `docs/spec/11-mcp-tools.md`
 */
export const TOOL_NAMING: Record<McpToolName, 'addendum' | 'point-of-use'> = {
  // Every agent may raise, on every dispatch, so no single prompt could name it.
  raise: 'addendum',
  escalate: 'addendum',
  plan_submit: 'addendum',
  // Reached by the appraiser, a part agent and a reviewer alike, so no one prompt owns it.
  plan_correct: 'addendum',
  world_read: 'addendum',
  open_pr: 'addendum',
  note_progress: 'addendum',
  // A request for a person to act rather than an observation, so not folded into `raise`.
  request_human_task: 'addendum',
  // Named by `pr-review-comment`'s appendix, which also tells the agent not to post to the
  // thread itself — the half a tool description cannot carry.
  reply_to_review: 'point-of-use',
  // Terminal or task-scoped: the dispatch prompt names these where they are used.
  link_ticket: 'point-of-use',
  // Named by `issue-plan`. Kept out of the addendum: an agent that is not planning cannot
  // cast it, and the addendum is read by every one of them.
  plan_not_needed: 'point-of-use',
  conclude_work: 'point-of-use',
  conclude_part: 'point-of-use',
  assess_issue: 'point-of-use',
  appraise_issue: 'point-of-use',
  retro_submit: 'point-of-use',
  feature_summary: 'point-of-use',
  // Named by `feature-sequence`, the only dispatch whose origin can call it.
  sequence_submit: 'point-of-use',
  scratch_append: 'point-of-use',
  scratch_read: 'point-of-use',
  validation_report: 'point-of-use',
  // Named in the `local-validation` prompt's tool section, the only agent with an
  // environment to read. An addendum entry would let an agent on somebody else's branch
  // read a machine running code that is not theirs.
  local_validation_plan: 'point-of-use',
  local_run_read: 'point-of-use',
  local_validation_report: 'point-of-use',
  // Named by `pr-review`, the one prompt whose agent can cast it, and the only way a fleet
  // review is recorded at all.
  review_report: 'point-of-use',
  // Named by `pr-review-triage`, the one prompt whose agent can cast it.
  review_route: 'point-of-use',
  validation_amend: 'point-of-use',
  // Named by the work prompts' own watch note: the instruction dispatching the work that
  // would emit the watched thing is the only one with a reason to reach for it.
  watch_declare: 'point-of-use',
  report_remedy: 'point-of-use',
  // Named by `review-pack-author`, the one prompt whose agent can cast it, and the only way
  // a pack lands at all.
  review_pack_submit: 'point-of-use',
  // Named by `review-pack-check`, the one prompt whose agent can cast it.
  review_pack_check: 'point-of-use',
  // The one tool an agent is never told about: Claude Code calls it through
  // --permission-prompt-tool, so naming it would invite a call that means nothing.
  request_permission: 'point-of-use',
};

/**
 * Tool names this harness used to answer to and no longer does. `raise` replaced the first
 * four; `knowledge_ask` joined when the claim store went.
 *
 * A withdrawn name is kept and marked rather than deleted, because a name that is simply
 * gone comes back as an unknown method: the setup reading warns an operator whose override
 * names one, a call is answered with a refusal naming `raise`, and being answered it is
 * recorded. A name is never removed from this list.
 *
 * → `docs/spec/11-mcp-tools.md#retired-tools`, `docs/spec/26-setup.md#an-override-that-names-a-retired-tool`
 */
export const RETIRED_TOOL_NAMES: readonly string[] = [
  'report_finding',
  'knowledge_propose',
  'knowledge_notice',
  'knowledge_contradict',
  'knowledge_ask',
];

/** What a call to a retired tool is told, so the answer names the door that replaced it. */
export function retiredToolMessage(name: string): string {
  return (
    `${name} has been retired. Everything it did is now one call: raise(what, why_not_mine) — say what ` +
    'you hit and why it is not your own change doing, and the harness works out the rest. **The call ' +
    'is the lookup**: it comes back with whether anybody else has hit it, who owns it if anyone does, ' +
    'and what they saw. There is no search tool; call raise the moment you are in pain. If you reached ' +
    'this from a prompt that named it, that prompt is out of date.'
  );
}

/**
 * The names as the permission layer sees them. An `--mcp-config` server connects without
 * approval, but its tool calls are still permission-gated and `acceptEdits` does not cover
 * them; without these grants every call is refused with no human at the prompt. A tool added
 * to {@link buildTools} but not to {@link MCP_TOOL_NAMES} still connects and advertises, and
 * every call to it is refused with nothing in the logs.
 */
export const ALLOWED_MCP_TOOLS: string[] = MCP_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_ID}__${name}`);

/**
 * The grants for the MCP servers one dispatch carries beside the harness's own. Server-level
 * rather than per tool: a bare `mcp__<server>` rule matches every tool that server offers,
 * where enumerating an extra server's tools would keep a copy of somebody else's API that
 * goes stale silently.
 */
export function extraMcpGrants(servers: readonly { key: string }[]): string[] {
  return servers.map((server) => `mcp__${server.key}`);
}

/**
 * The desktop channel's tools — a separate, much shorter list, and separate on purpose. The
 * operator's own Claude Code connects to a different socket with a long-lived credential and
 * no dispatch behind it. Writing the list out rather than filtering {@link MCP_TOOL_NAMES} is
 * what makes the narrowing structural: `src/mcp/desktopTools.ts` is a `Record` over exactly
 * this, and there is no path from a desktop connection to `buildTools`.
 *
 * Names that look shared are deliberately distinct — one name over two fences is the trap
 * this module exists to prevent: `validation_report` here takes the check from what the
 * session claimed where the fleet's takes it from the dispatch origin; `plan_amend` reaches
 * an `active` plan's proposal where the fleet's `plan_correct` is fenced by dispatch origin
 * and cannot write; `goal_read` answers the harness's own history of a run where `world_read`
 * answers a provider's view of an item; `human_task_settle` settles a bench row where
 * `escalation_answer` answers a parked agent's question.
 * → `docs/spec/13-jobs-and-tickets.md#it-is-not-an-escalation-and-the-difference-is-not-a-nuance`
 *
 * `goal_gate`, `goal_placement` and `goal_instruct` are the goal's own decisions, split three
 * ways because they differ in kind: escape hatches that hold work, placement questions that
 * write to the tracker, and words in front of the next agent. → `src/mcp/desktopGoal.ts`
 *
 * The fleet half — `fleet_status`, `attention_read`, `agent_read`, `fleet_control`,
 * `queue_control`, `escalation_answer`, `human_task_settle`, `goal_control` — is about the
 * harness rather than one goal; five names act rather than steer: `proposal_read` /
 * `proposal_decide` settle an act that for a `merge` or `reply_draft` cannot be taken back,
 * `recovery_decide` rules on a crash-orphaned run, `job_create` puts work in, `agent_control`
 * drives a live agent. No tool here concludes a goal, writes a plan document, opens a pull
 * request or reports a validation on work it did itself. → `docs/spec/11-mcp-tools.md#watching-and-steering-the-fleet`
 *
 * No `ALLOWED_MCP_TOOLS` equivalent: the fleet's grants exist because nobody is at the
 * prompt to approve a call. Here somebody is, and it is their own machine.
 */
export const DESKTOP_TOOL_NAMES = [
  'goal_read',
  'fleet_status',
  'fleet_control',
  'attention_read',
  'escalation_answer',
  'human_task_settle',
  'agent_read',
  'queue_control',
  'goal_control',
  'goal_gate',
  'goal_placement',
  'goal_instruct',
  'proposal_read',
  'proposal_decide',
  'recovery_decide',
  'job_create',
  'agent_control',
  'validation_read',
  'validation_claim',
  'validation_report',
  'plan_read',
  'plan_amend',
  'sequence_read',
  'sequence_amend',
  'local_run',
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

/**
 * The qualified name passed to `claude --permission-prompt-tool`. Derived from the same
 * server id and tool name as every grant above, so it cannot drift from what `buildTools`
 * exposes.
 */
export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_ID}__request_permission`;
