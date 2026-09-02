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
 * Whether this dispatch needs a **read-only** checkout rather than a branch of its
 * own (issue #396) — see `Worktrees.ensureReadOnly` and `readOnlyDispatch`.
 *
 * Defaults to false, which is what every dispatch that writes code is, so a rule
 * that says nothing gets the writable shape it always had. The three rules that
 * only read say so through `readOnlyDispatch`, never by setting this themselves:
 * three literals is three chances for one of them to drift back to minting a
 * branch nothing will ever reap.
 */
const checkout = {
  readOnly: z.boolean().default(false),
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
    ...checkout,
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
     * Mark the thread resolved once the reply lands. The agent's own verdict on
     * the thread it answered (`reply_to_review`'s `resolved`), carried on the act
     * so the operator authorizes the reply and the resolution together — the
     * reply is what the resolution claims to justify. Ignored without a
     * `commentId`: there is no thread to resolve on a reply to the pull request.
     */
    resolve: z.boolean().default(false),
    ...base,
  }),
  z.object({
    type: z.literal('merge_pr'),
    prNumber: z.number().int(),
    /** How to land the branch. Defaults to a squash merge. */
    method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
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
    /**
     * What the plan raises that has to be *read* before it may be released —
     * `src/plans/planCaveats.ts`. Carried on the action rather than re-derived at
     * accept time so the gate compares the operator's ticks against the list they
     * were actually shown; empty is a plan that raises nothing, and no gate.
     */
    caveats: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          detail: z.string().min(1).nullable().default(null),
        }),
      )
      .default([]),
    /** What the operator is shown: what the plan is for, and what each verdict means. */
    prompt: z.string().min(1),
    ...base,
  }),
  /**
   * Put a change to a **running** plan to a human (`src/plans/planAmendment.ts`).
   * Like `propose_plan` it carries no act to publish: the executor turns it into an
   * inbox item plus a `plan_amendment` proposal, and accepting that proposal
   * ingests the amended document while the plan stays released.
   *
   * The document is deliberately **not** in the payload — it is on the
   * `plan_amendments` row, which is also what the rule reads and what both
   * settlements rewrite. An action carrying the document would be a second copy of
   * it that could be accepted after the row it came from was superseded.
   */
  z.object({
    type: z.literal('propose_plan_amendment'),
    /** The pending amendment row; what accepting applies and rejecting settles. */
    amendmentId: z.string().min(1),
    /** The plan being amended — carried so the audit line can name it without a lookup. */
    planId: z.string().min(1),
    /** The goal the plan hangs off (`issue:12`). */
    originRef: z.string().min(1),
    /**
     * What the operator is shown: what is being changed, and what each verdict
     * does.
     *
     * There is no `detail` beside it, unlike every other proposing action. The
     * card's body — why, what changes, what it will not change — is a *reading of
     * the plan as it stands*, built by the executor from the store when the card
     * is created, so it cannot describe a diff against a plan that has moved on
     * since the rule ran.
     */
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
   * Emitted only by rule `pr-base-update` — the case the provider has already
   * said merges cleanly — and never by `pr-base-update-conflict`, which is
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
  /**
   * Queue a fresh run of the **expired** build policies holding a pull request's
   * gate, without spending a code agent on it (issue #395).
   *
   * Emitted only by rule `pr-ci-gate`'s expired arm — a check the provider itself
   * says nothing is running and nothing will start for, whose resolution the
   * harness therefore knows without asking a model. The *guided* arm keeps its
   * agent: only the operator's words can say what releases a check they asked to
   * be watched, and a check that is both expired and guided keeps them too.
   *
   * Like {@link update_pr_branch} it claims no headroom, is pushed straight
   * through, and is audited under `originRef` so the gate's cooldown and attempt
   * accounting stay whole whoever performed the attempt.
   */
  z.object({
    type: z.literal('requeue_ci_check'),
    prNumber: z.number().int(),
    /**
     * Every expired check on this gate, as a name for the audit line and the
     * provider's own opaque handle for the write.
     *
     * A list rather than one check because the concern is one per pull request: a
     * repository with two required builds expires both on the same push, and
     * splitting them across pulses would spend the origin's whole attempt budget
     * on a gate nothing was wrong with. One write each, one pulse, one decision row.
     */
    checks: z.array(z.object({ name: z.string().min(1), requeueRef: z.string().min(1) })).min(1),
    /**
     * `pr:<n>:ci-gate`, the concern's own origin — the key the attempt counter and
     * the next cycle's fallback both read, for {@link update_pr_branch}'s reason.
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
