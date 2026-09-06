import { z } from 'zod';

/**
 * The bounded action vocabulary the dispatcher may emit. Output is validated against these
 * schemas at the boundary; anything malformed is rejected and logged rather than executed.
 */

const base = {
  reason: z.string().min(1),
  /** Which dispatcher rule produced this action (a `DISPATCH_RULES` id), for the audit log. Null for an act reaching the executor from outside the pulse. */
  rule: z.string().nullable().default(null),
  /**
   * What *became* of the proposal `rule` names — an `admission`-kind id from the
   * same registry, in its own column. Null when a rule's proposal was admitted
   * unchanged; the two columns answer different questions.
   */
  admission: z.string().nullable().default(null),
};

/** Human-readable context about the item that triggered a dispatch, carried onto the task so the cockpit can explain a running agent. Null for an act composed outside a rule. */
const origin = {
  originTitle: z.string().nullable().default(null),
  originSummary: z.string().nullable().default(null),
};

/** Links a dispatch back to the operator-launched {@link Job} it drains, so the executor can mark that job dispatched once its agent spawns. Null for every world-driven dispatch. */
const job = {
  jobId: z.string().nullable().default(null),
};

/**
 * Links a dispatch to the {@link PlanPart} it works, so the executor can record
 * the part dispatched once its agent spawns — and carries the branch that part
 * stacks on. `base` is only consulted when the branch doesn't exist yet; null
 * means the executor's default branch.
 */
const part = {
  partId: z.string().nullable().default(null),
  base: z.string().min(1).nullable().default(null),
};

/**
 * Whether this dispatch needs a **read-only** checkout rather than a branch of
 * its own. Defaults false. Read-only rules say so through `readOnlyDispatch`
 * and never by setting this themselves.
 */
const checkout = {
  readOnly: z.boolean().default(false),
};

/**
 * The model profile this dispatch's origin is pinned to — a goal's tag, or the
 * profile its plan named for this part. Null means priced by the rule. Carried
 * on the action because the pin is a property of the world the executor cannot see.
 */
const pin = {
  profile: z.string().min(1).nullable().default(null),
};

/**
 * MCP servers this dispatch carries **beside** the harness's own, and the local
 * validation row it is for. Set by the two `local-validation*` rules and
 * nothing else.
 */
const extraTools = {
  mcpServers: z
    .array(
      z.object({
        // Every `mcp__<key>__<tool>` permission name derives from this key, so a `_` or a
        // space in it would grant something else, or nothing.
        key: z.string().regex(/^[a-z][a-z0-9-]*$/, 'an MCP server key is lower-case letters, digits and hyphens'),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  localValidation: z
    .object({ id: z.string().min(1), as: z.enum(['validation', 'fix']) })
    .nullable()
    .default(null),
};

const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dispatch_code_agent'),
    branch: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
    originRef: z.string().nullable().default(null),
    /** The individual world signals this dispatch answers, finer-grained than `originRef` — used for `dispatchedSignalsByBranch` de-dup. */
    signalRefs: z.array(z.string()).optional(),
    /** The CI checks this dispatch answers, as the provider names them. Set by the two CI rules; absent elsewhere. */
    ciChecks: z.array(z.string()).optional(),
    ...origin,
    ...job,
    ...part,
    ...pin,
    ...checkout,
    ...extraTools,
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
    /** Mark the thread resolved once the reply lands. Ignored without a `commentId`: a reply to the pull request has no thread to resolve. */
    resolve: z.boolean().default(false),
    /** The dispatch origin that asked for this reply, where an agent did — identifies which reply this is once through JSON and a proposal row. Null on a rule's draft. */
    originRef: z.string().nullable().default(null),
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
   * Put an issue's decomposition to a human before anything is scheduled from
   * it. Carries no act to publish: the executor turns it into an inbox item
   * plus a `plan` proposal, and accepting releases the plan row.
   */
  z.object({
    type: z.literal('propose_plan'),
    /** The plan row the verdict landed on; what accepting/refusing transitions. */
    planId: z.string().min(1),
    /** The issue the plan hangs off (`issue:12`) — the proposal's ref is derived from it. */
    originRef: z.string().min(1),
    /** What the plan diagnosed and will do, as quoted markdown. Null when the planner wrote neither. */
    detail: z.string().min(1).nullable().default(null),
    /** What the plan raises that must be *read* before release (`src/plans/planCaveats.ts`). Carried rather than re-derived at accept time. Empty is no gate. */
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
   * Like `propose_plan` it carries no act to publish; accepting ingests the
   * amended document while the plan stays released. The document is
   * deliberately **not** in the payload — it lives on the `plan_amendments` row,
   * since a copy here could be accepted after the row it came from was superseded.
   */
  z.object({
    type: z.literal('propose_plan_amendment'),
    /** The pending amendment row; what accepting applies and rejecting settles. */
    amendmentId: z.string().min(1),
    /** The plan being amended — carried so the audit line can name it without a lookup. */
    planId: z.string().min(1),
    /** The goal the plan hangs off (`issue:12`). */
    originRef: z.string().min(1),
    /** What the operator is shown: what is being changed, and what each verdict does. No `detail` beside it — the card's body is built at card time so it cannot describe a stale diff. */
    prompt: z.string().min(1),
    ...base,
  }),
  /**
   * Put an assessor's "worked, and the goal is not reached" to a human, with the
   * arm its declared cause routes to. Accepting performs the arm — a replan, or
   * a follow-up part. A proposal, not automatic: both arms spend a fleet.
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
    /** The assessor's verdict as quoted markdown, beside `prompt` so the cockpit can label the block and an override cannot bury it. */
    detail: z.string().min(1).nullable().default(null),
    /** What the operator is shown: what fell short, and what accepting does. */
    prompt: z.string().min(1),
    ...base,
  }),
  /**
   * Bring a pull request that is merely **behind** its base up to date, without
   * spending a code agent on two git commands. Emitted only by rule
   * `pr-base-update`. Claims no headroom; audited under `originRef`.
   */
  z.object({
    type: z.literal('update_pr_branch'),
    prNumber: z.number().int(),
    /** The base branch being merged in — for the audit line, not the provider. */
    base: z.string().min(1),
    /** The PR's own branch, the thing being written to. Carried so the executor can re-check the branch gate. */
    branch: z.string().min(1),
    /** `pr:<n>:mergeable`, the concern's own origin — the key the attempt counter and fallback both read. */
    originRef: z.string().min(1),
    ...base,
  }),
  /**
   * Queue a fresh run of the **expired** build policies holding a pull
   * request's gate, without spending a code agent. Emitted only by rule
   * `pr-ci-gate`'s expired arm. Claims no headroom and is audited under `originRef`.
   */
  z.object({
    type: z.literal('requeue_ci_check'),
    prNumber: z.number().int(),
    /** Every expired check on this gate: a name for the audit line and the provider's opaque requeue handle. */
    checks: z.array(z.object({ name: z.string().min(1), requeueRef: z.string().min(1) })).min(1),
    /** `pr:<n>:ci-gate`, the concern's own origin. */
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
