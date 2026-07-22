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
   * the LLM dispatcher reasons freely and omits it — so it defaults to null.
   */
  rule: z.string().nullable().default(null),
};

/**
 * Human-readable context about the item that triggered a dispatch, carried onto
 * the task so the cockpit can explain a running agent at a glance (issue #17).
 * Optional — an LLM dispatcher may omit it — so both default to null.
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

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dispatch_code_agent'),
    branch: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
    originRef: z.string().nullable().default(null),
    ...origin,
    ...job,
    ...base,
  }),
  z.object({
    type: z.literal('dispatch_desk_agent'),
    title: z.string().min(1),
    prompt: z.string().min(1),
    originRef: z.string().nullable().default(null),
    ...origin,
    ...job,
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
