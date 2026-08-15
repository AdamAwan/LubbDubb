import { z } from 'zod';

/**
 * The bounded action vocabulary the dispatcher may emit. The dispatcher reasons
 * freely, but its output is validated against these schemas at the boundary —
 * anything malformed is rejected and logged rather than executed. This is what
 * keeps an LLM decision-maker safe: it can only ever ask for one of these.
 */

const base = {
  reason: z.string().min(1),
  /**
   * Which dispatcher rule produced this action (a `DISPATCH_RULES` id), so the
   * audit log can explain the decision beyond its free-text reason. Optional —
   * an act reaching the executor from outside the pulse (an accepted proposal,
   * agent lifecycle) has no proposing rule — so it defaults to null.
   */
  rule: z.string().nullable().default(null),
  /**
   * What *became* of the proposal `rule` names — an `admission`-kind id from the
   * same registry (`branch-notify`, `cooldown-escalate`), lifted into its own
   * decision column beside `rule`. Null for the ordinary case, which is a rule's
   * proposal admitted unchanged; the two columns answer different questions and
   * neither is the other's fallback.
   *
   * Only the admissions that **emit an action** reach here. The rest
   * (`cooldown`, `capped`, `unapproved`, `superseded`, `waiting`) hold a
   * candidate that was never executed, so they are queue statuses on the Up next
   * projection and produce no decision row at all.
   */
  admission: z.string().nullable().default(null),
};

/**
 * Human-readable context about the item that triggered a dispatch, carried onto
 * the task so the cockpit can explain a running agent at a glance (issue #17).
 * Optional — an act composed outside a rule has no world item to describe — so
 * both default to null.
 */
const origin = {
  originTitle: z.string().nullable().default(null),
  originSummary: z.string().nullable().default(null),
};

/**
 * Links a dispatch back to the operator-launched {@link Job} it drains, so the
 * executor can mark that job dispatched once its agent spawns. Null for every
 * world-driven dispatch — only the queue-draining rule sets it.
 */
const job = {
  jobId: z.string().nullable().default(null),
};

/**
 * Links a dispatch to the {@link PlanPart} it works, so the executor can record the
 * part dispatched once its agent spawns — and carries the branch that part stacks
 * on. `base` is only consulted when the branch doesn't exist yet (see
 * `WorktreeManager.ensure`); null means the executor's configured default branch,
 * which is every dispatch but a stacked part's.
 */
const part = {
  partId: z.string().nullable().default(null),
  base: z.string().min(1).nullable().default(null),
};

/**
 * The model profile this dispatch's origin is pinned to (issue #342) — a goal's
 * tag, or the profile its plan named for this part. Null for the ordinary case,
 * which is a dispatch priced by its rule.
 *
 * Carried on the action rather than resolved at the executor because the pin is a
 * property of the *world* — a label on a ticket, a field on a plan row — and the
 * executor sees neither. Stamped in one place, where a candidate clears the
 * headroom cut, so no rule can compose a dispatch that quietly loses it.
 */
const pin = {
  profile: z.string().min(1).nullable().default(null),
};

const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dispatch_code_agent'),
    branch: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
    originRef: z.string().nullable().default(null),
    /**
     * The individual world signals this dispatch was launched to answer, when
     * they are finer-grained than `originRef`. Only the review-comment rule sets
     * more than one: it folds every open thread on a PR onto a single origin so
     * one agent answers the whole review, which leaves the origin unable to say
     * *which* threads the agent already has. Recorded here so the branch-notify
     * de-dup doesn't read them straight back to it (`dispatchedSignalsByBranch`).
     */
    signalRefs: z.array(z.string()).optional(),
    /**
     * The CI checks this dispatch answers, as the provider names them. Carried
     * onto the task so spend can be read back per check (`src/taskTypeSpend.ts`)
     * — the dispatch reason names them too, but only in a sentence, and the read
     * path must never parse one. Set by the two CI rules; absent everywhere else.
     */
    ciChecks: z.array(z.string()).optional(),
    ...origin,
    ...job,
    ...part,
    ...pin,
    ...base,
  }),
  z.object({
    type: z.literal('dispatch_desk_agent'),
    title: z.string().min(1),
    prompt: z.string().min(1),
    originRef: z.string().nullable().default(null),
    ...origin,
    ...job,
    ...pin,
    ...base,
  }),
  z.object({
    type: z.literal('escalate_to_human'),
    escalationType: z.enum(['approve_change', 'answer_question', 'resolve_ambiguity', 'review_reply']),
    prompt: z.string().min(1),
    context: z.record(z.unknown()).default({}),
    taskId: z.string().nullable().default(null),
    agentId: z.string().nullable().default(null),
    ...base,
  }),
  z.object({
    type: z.literal('respond_to_agent'),
    agentId: z.string().min(1),
    response: z.string().min(1),
    /** The PR concern origins this note covers, for the audit log + notify de-dup. */
    originRefs: z.array(z.string()).optional(),
    ...base,
  }),
  z.object({
    type: z.literal('reply_on_pr'),
    prNumber: z.number().int(),
    commentId: z.string().nullable().default(null),
    draft: z.string().min(1),
    /**
     * The dispatcher's self-reported confidence in this reply, 0..1. Gates
     * auto-send: at or above the configured threshold (and with auto-send
     * enabled) the harness sends it; otherwise it drafts and escalates. Absent
     * is treated as 0 — no confidence stated means never auto-send.
     */
    confidence: z.number().min(0).max(1).optional(),
    ...base,
  }),
  z.object({
    type: z.literal('merge_pr'),
    prNumber: z.number().int(),
    /** How to land the branch. Defaults to a squash merge. */
    method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
    /** Self-reported confidence, 0..1. Gates auto-merge the same way `reply_on_pr` gates auto-send. */
    confidence: z.number().min(0).max(1).optional(),
    ...base,
  }),
  /**
   * Put an issue's decomposition to a human before anything is scheduled from it
   * (issue #109 phase 3). Unlike every other proposal-bearing action this one
   * carries no act to publish: the executor turns it into an inbox item plus a
   * `plan` proposal, and accepting that proposal releases the plan row. It is an
   * action rather than a store write at ingestion time so proposals keep being
   * born in exactly one place — the executor, from a validated action.
   */
  z.object({
    type: z.literal('propose_plan'),
    /** The plan row the verdict landed on; what accepting/refusing transitions. */
    planId: z.string().min(1),
    /** The issue the plan hangs off (`issue:12`) — the proposal's ref is derived from it. */
    originRef: z.string().min(1),
    /**
     * What the plan diagnosed and what it will do about it, as quoted markdown —
     * carried beside `prompt` for `propose_shortfall`'s reason: the cockpit labels
     * the block, and an operator's prompt override cannot bury the planner's own
     * words in a paragraph. Null when the planner wrote neither.
     */
    detail: z.string().min(1).nullable().default(null),
    /** What the operator is shown: what the plan is for, and what each verdict means. */
    prompt: z.string().min(1),
    ...base,
  }),
  /**
   * Put an assessor's "worked, and the goal is not reached" to a human, with the
   * arm its declared cause routes to (issue #159). Like `propose_plan` it carries
   * no act to publish: the executor turns it into an inbox item plus a `shortfall`
   * proposal, and accepting that proposal performs the arm — a replan, or a
   * follow-up part. It is a proposal rather than an automatic action because both
   * arms spend a fleet and a plan the harness rewrote on its own would churn
   * `plan_parts` under whatever was already running.
   */
  z.object({
    type: z.literal('propose_shortfall'),
    /** The issue the shortfall is about (`issue:12`) — the proposal's ref derives from it. */
    originRef: z.string().min(1),
    /** The issue number, so the executor need not re-parse the origin to name the ref. */
    issueNumber: z.number().int(),
    /** The plan the arm acts on. Both arms transition a plan, so both need one. */
    planId: z.string().min(1),
    /** What the assessor said fell short — decides which arm accepting performs. */
    cause: z.enum(['plan', 'part']),
    /** The part that fell short; required by the `part` arm and unused by the other. */
    partSlug: z.string().min(1).nullable().default(null),
    /** The assessor's own words: the replan's context, or the follow-up part's scope. */
    summary: z.string().min(1),
    /**
     * The assessor's verdict as quoted markdown, for the card's body. Carried
     * beside `prompt` rather than inside it so the cockpit can label the block —
     * and so an operator's prompt override cannot bury it in a paragraph.
     */
    detail: z.string().min(1).nullable().default(null),
    /** What the operator is shown: what fell short, and what accepting does. */
    prompt: z.string().min(1),
    ...base,
  }),
  /**
   * Bring a pull request that is merely **behind** its base up to date, without
   * spending a code agent on two git commands (issue #332).
   *
   * Emitted only by rule `pr-base-update`'s `behind` arm — the case the provider
   * has already said merges cleanly — and never for a conflict, which is
   * judgement and keeps its agent. It claims no headroom and is pushed straight
   * through, like `merge_pr` and `set_work_item_state`; the executor performs it
   * against the sink and audits the outcome under `originRef`, which is what keeps
   * the origin's cooldown and attempt accounting whole.
   */
  z.object({
    type: z.literal('update_pr_branch'),
    prNumber: z.number().int(),
    /** The base branch being merged in — for the audit line, not for the provider. */
    base: z.string().min(1),
    /**
     * The PR's own branch — the thing being written to. Carried so the executor
     * can re-check the branch gate it re-checks for a dispatch, and for the same
     * reason: the rule only proposes this for a free branch, but every path that
     * reaches the executor must be covered, not just the one that checked first.
     */
    branch: z.string().min(1),
    /**
     * `pr:<n>:mergeable`, the concern's own origin. Required rather than
     * defaulted: it is the key the attempt counter and the next cycle's fallback
     * both read, and an act that carried none would be invisible to both.
     */
    originRef: z.string().min(1),
    ...base,
  }),
  z.object({
    type: z.literal('set_work_item_state'),
    /** The work item / issue number to transition. */
    number: z.number().int(),
    /** The provider-native state to move it to (e.g. Azure "In Review"). */
    state: z.string().min(1),
    ...base,
  }),
  z.object({ type: z.literal('no_op'), ...base }),
]);

export type ValidatedAction = z.infer<typeof ActionSchema>;

export interface ParseResult {
  actions: ValidatedAction[];
  /** Items that failed validation, kept for the audit log. */
  rejected: { raw: unknown; error: string }[];
}

/** Validate a raw action array, partitioning valid from rejected items. */
export function parseActions(raw: unknown): ParseResult {
  const arr = Array.isArray(raw) ? raw : [];
  const actions: ValidatedAction[] = [];
  const rejected: { raw: unknown; error: string }[] = [];
  for (const item of arr) {
    const result = ActionSchema.safeParse(item);
    if (result.success) actions.push(result.data);
    else
      rejected.push({
        raw: item,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
  }
  return { actions, rejected };
}
