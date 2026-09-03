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
  'open_pr',
  'reply_to_review',
  'validation_amend',
  'validation_report',
  'watch_declare',
  'review_report',
  'review_route',
  'report_remedy',
  'raise',
  'knowledge_ask',
  'review_pack_submit',
  'review_pack_check',
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
 *
 * There is no third class. The four `raise` replaced were a `superseded` one for
 * a release — registered, granted and named nowhere — and they are gone; what
 * kept them was that a withdrawn name fails *silently*, and {@link
 * RETIRED_TOOL_NAMES} is what answers that instead.
 *
 * **This lives beside the names rather than in `test/mcpChannel.test.ts`, where it
 * was written.** The Insights MCP tab reads it to say what a tool's silence
 * *means* — an `addendum` tool nothing called is a broken channel or a prompt that
 * stopped naming it, where a `point-of-use` tool's silence only tracks what ran —
 * and a classification a test owns is a classification production code has to
 * keep a second copy of: free to disagree with what is actually granted,
 * silently, which is the failure the whole module exists to make impossible. The
 * test asserts *against* it instead, in both directions.
 *
 * A `Record` over {@link McpToolName}, so a new tool does not compile until it has
 * been classified.
 */
export const TOOL_NAMING: Record<McpToolName, 'addendum' | 'point-of-use'> = {
  // The one door. Every agent may raise, on every dispatch, so there is no single
  // prompt that could name it — which is the addendum's own criterion.
  raise: 'addendum',
  escalate: 'addendum',
  plan_submit: 'addendum',
  // Every agent working a planned goal may find the plan wrong, and no one
  // dispatch prompt is where that happens — the appraiser, a part agent and a
  // reviewer all reach it. An addendum tool nothing has called is a signal worth
  // reading here: either no plan has been wrong, or the agents cannot see it.
  plan_correct: 'addendum',
  world_read: 'addendum',
  open_pr: 'addendum',
  note_progress: 'addendum',
  // Every agent may read the knowledge base, and it has no point of use to be named
  // at: a tool named nowhere but in `tools/list` is a tool an agent finishes without.
  knowledge_ask: 'addendum',
  // A request for a person to act rather than an observation, which is why it did
  // not fold into `raise` — and why it still needs naming.
  request_human_task: 'addendum',
  // Named by `pr-review-comment`'s appendix, which is also where the agent is
  // told not to post to the thread itself — the half a tool description alone
  // cannot carry, since the habit it is displacing predates the tool.
  reply_to_review: 'point-of-use',
  // Terminal or task-scoped: the dispatch prompt names these where they are used.
  link_ticket: 'point-of-use',
  // The planner's other verdict, named by `issue-plan` where the planner is told
  // what its job is. Deliberately *not* in the addendum beside `plan_submit`: an
  // agent that is not planning cannot cast it, and the addendum is read by every
  // one of them.
  plan_not_needed: 'point-of-use',
  conclude_work: 'point-of-use',
  conclude_part: 'point-of-use',
  assess_issue: 'point-of-use',
  appraise_issue: 'point-of-use',
  retro_submit: 'point-of-use',
  feature_summary: 'point-of-use',
  scratch_append: 'point-of-use',
  scratch_read: 'point-of-use',
  validation_report: 'point-of-use',
  // Named by `pr-review`, the one prompt whose agent can cast it — and the only
  // way a fleet review is recorded at all, which is why the prompt says so twice.
  review_report: 'point-of-use',
  // Named by `pr-review-triage`, the one prompt whose agent can cast it.
  review_route: 'point-of-use',
  validation_amend: 'point-of-use',
  // Named by the work prompts' own watch note — the instruction that has a reason
  // to reach for it is the one dispatching the work that would emit the thing
  // being watched, and an addendum entry would be read by every planner and
  // assessor that cannot use it.
  watch_declare: 'point-of-use',
  report_remedy: 'point-of-use',
  // Named by `review-pack-author`, the one prompt whose agent can cast it — and
  // the only way a pack lands at all, which is why that prompt says so twice.
  review_pack_submit: 'point-of-use',
  // Named by `review-pack-check`, the one prompt whose agent can cast it — and
  // the only way a verdict lands at all.
  review_pack_check: 'point-of-use',
  // The one tool an agent is never told about: Claude Code calls it through
  // --permission-prompt-tool, so naming it would invite a call that means nothing.
  request_permission: 'point-of-use',
};

/**
 * Tool names this harness used to answer to and no longer does.
 *
 * `raise` replaced all four, and they spent a release registered-but-named-nowhere
 * rather than deleted, for one reason: a withdrawn tool name fails **silently**.
 * An operator's prompt override written before the intake still names one, the
 * call comes back as an unknown method, and nothing in the logs says why — on
 * exactly the deployments that customised most.
 *
 * Deleting the implementations does not have to mean accepting that, and this is
 * the same answer `PromptId` gives to the same problem: the *name* is kept and
 * marked withdrawn, so it stays loud in three places. The setup reading still
 * warns an operator whose override names one; a call to one is answered with a
 * refusal that names `raise` rather than an unknown-method error; and because it
 * is answered, it is **recorded**, so the Insights MCP tab shows a deployment
 * still reaching for a tool that is gone.
 *
 * A name is never removed from this list. It costs one string, and taking one out
 * puts that deployment back on the silent failure this list exists to end.
 *
 * → `docs/spec/11-mcp-tools.md#retired-tools`, `docs/spec/26-setup.md#an-override-that-names-a-retired-tool`
 */
export const RETIRED_TOOL_NAMES: readonly string[] = [
  'report_finding',
  'knowledge_propose',
  'knowledge_notice',
  'knowledge_contradict',
];

/** What a call to a retired tool is told, so the answer names the door that replaced it. */
export function retiredToolMessage(name: string): string {
  return (
    `${name} has been retired. Everything it did is now one call: raise(claim, evidence) — say what you ` +
    'learned and what you saw, and the harness works out where it goes. Add `contradicts: <id>` if you ' +
    'are disputing a claim the harness gave you, or `until: <hours>` if it is only true for now. If you ' +
    'reached this from a prompt that named it, that prompt is out of date.'
  );
}

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
 * `plan_correct` is the fleet's tool for the same *sort* of act and is a third
 * name again, deliberately. It proposes a change to a plan that is already
 * running and **cannot write at all** — the row it leaves is answered by an
 * operator. `plan_amend` reaches that same proposal on an `active` plan, which is
 * not a reason to fold the two into one name: this one is fenced by the origin
 * its caller was dispatched on and is offered to every agent working a part,
 * while `plan_amend` is fenced by the plan's status and is offered to one
 * long-lived credential in the operator's home directory. One name over two
 * fences is the `validation_report` trap above, and the fences are exactly what
 * an edit to "the plan tool" would silently reach past.
 *
 * `plan_amend` is deliberately **not** a second `plan_submit`. It carries the same
 * document — rewriting an `awaiting_approval` plan through the same ingestion,
 * proposing against an `active` one — but a shared name would make it the trap
 * above without the warning: an edit to "the plan tool" that silently reaches one
 * channel. A different name on each side is the whole of the defence, and the
 * document schema they genuinely do share is one export
 * (`src/mcp/planDocumentSchema.ts`) rather than two literals.
 *
 * **`goal_gate`, `goal_placement` and `goal_instruct` are the goal's own decisions**,
 * and they are here because without them this channel could see a held goal and do
 * nothing about it. Four of the cockpit's goal controls hold work — an appraisal
 * that came back `unclear`, a model profile nobody confirmed, a shortfall against a
 * goal that is finished, an environment gate on work that will never deploy — and
 * every one of them was a click in a browser tab on one machine. A session asked to
 * settle one reached for the nearest name that would take the call (`human_task_settle`
 * clears the wrapper task), reported the gate settled, and left it standing.
 *
 * Three names rather than one, on {@link DESKTOP_TOOL_NAMES}'s own rule: `goal_gate`
 * is the escape hatches, which hold work and are answered together; `goal_placement`
 * is the two placement questions, which write to the tracker and hold nothing;
 * `goal_instruct` is words in front of the next agent, which is input rather than a
 * verdict and is the one of the three that restarts a goal. The profile pin is an arm
 * of `goal_control` and not a fourth name, because it is the same act as the watch tag
 * beside it — a label on the ticket that says how the harness should work this goal.
 * → `src/mcp/desktopGoal.ts`
 *
 * `goal_read` is the one tool here that is *only* a read, and the only one whose
 * answer is not about a next step: it is what the harness kept about a goal — the
 * plan, the parts, the pull requests, the decisions the dispatcher took, what was
 * escalated, what was concluded — handed over so the operator can ask a question
 * about the work and get an answer from the record rather than from a session's
 * reading of the repository. It is named `goal_read` and not `world_read`
 * deliberately: the fleet's `world_read` answers a provider's view of one item,
 * where this answers the harness's own history of a run, and one name over both
 * would be the `validation_report` trap a third time.
 *
 * `local_run` is the one tool here with no goal in it and nothing to write. It
 * answers "how does this project start on this machine", which is the question a
 * session has to settle before it can carry out most checks — and the reason it
 * is not a field on `validation_read` is that `validation_read` refuses a goal
 * with no checks, which is exactly the goal somebody most often wants to look at.
 *
 * **The fleet half is twelve tools and it is a different job from the rest.** Every
 * other name here is about one goal: read its plan, argue with it, take one of its
 * checks. `fleet_status`, `attention_read` and `agent_read` are about the *harness*
 * — what it is running, what it is waiting on a person for, what one agent is
 * actually doing — and `fleet_control`, `queue_control`, `escalation_answer`,
 * `human_task_settle` and `goal_control` are the verbs an operator reaches for
 * between goals: change the cap or pause, re-order or drop from the queue, answer
 * the thing in "Needs you", settle a row on the bench, and start or stop the fleet
 * working a ticket.
 *
 * `human_task_settle` is a second name beside `escalation_answer` rather than an
 * arm on it, because the two rows are not the same object: an escalation is a
 * question one parked agent is blocked on, a human task is a unit of work that
 * outlives its agent. One name over both is the `validation_report` trap again,
 * and the failure it already produced was a bench row whose id `escalation_answer`
 * refused as "No escalation" — a session reporting the harness broken when what it
 * had was the wrong verb. → `docs/spec/13-jobs-and-tickets.md#it-is-not-an-escalation-and-the-difference-is-not-a-nuance`
 *
 * They exist because the cockpit was the only way to do any of it, and the cockpit
 * is a browser tab on one machine. An operator who wants their own agent watching
 * the fleet — noticing a park at 2am, answering a question, lowering the cap when
 * the account's window is nearly spent — had no surface to do it through that was
 * not the bearer token and forty hand-rolled endpoints.
 *
 * **Five of them act rather than steer, and they are named as such.**
 * `proposal_read` / `proposal_decide` settle an act the harness proposed — which
 * for a `merge` or a `reply_draft` publishes something that cannot be taken back;
 * `recovery_decide` rules on a run a crash orphaned; `job_create` puts work in
 * (filed as a watched ticket where a tracker is configured, so the funnel still
 * decides when it runs); `agent_control` types into, interrupts, completes or
 * stops a live agent. The channel is the operator's own hands at a distance, and
 * these are what "run it from anywhere" actually needs.
 *
 * What none of them is, is the *fleet's* surface: no tool here concludes a goal,
 * writes a plan document, opens a pull request or reports a validation reading on
 * work it did itself. Those stay behind the origin an agent was dispatched on.
 * → `docs/spec/11-mcp-tools.md#watching-and-steering-the-fleet`
 *
 * No `ALLOWED_MCP_TOOLS` equivalent: the fleet's grants exist because nobody is
 * at the prompt to approve a call. Here somebody is, and it is their own machine.
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
  'local_run',
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

/**
 * The qualified name passed to `claude --permission-prompt-tool` (issue #130 phase
 * B). Derived from the same server id + tool name as every grant above, so it can
 * never drift from the tool `buildTools` actually exposes.
 */
export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_ID}__request_permission`;
