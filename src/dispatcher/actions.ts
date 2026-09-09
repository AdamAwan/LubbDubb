import { z } from 'zod';

// → docs/spec/05-dispatcher.md

const base = {
  reason: z.string().min(1),
  rule: z.string().nullable().default(null),
  admission: z.string().nullable().default(null),
};

const origin = {
  originTitle: z.string().nullable().default(null),
  originSummary: z.string().nullable().default(null),
};

const job = {
  jobId: z.string().nullable().default(null),
};

const part = {
  partId: z.string().nullable().default(null),
  base: z.string().min(1).nullable().default(null),
};

const checkout = {
  readOnly: z.boolean().default(false),
};

const pin = {
  profile: z.string().min(1).nullable().default(null),
};

const extraTools = {
  mcpServers: z
    .array(
      z.object({
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
  /** The open run row this dispatch claims — the conditional flip is the store's, not the caller's. */
  remoteRun: z
    .object({ id: z.string().min(1) })
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
    signalRefs: z.array(z.string()).optional(),
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
    originRefs: z.array(z.string()).optional(),
    ...base,
  }),
  z.object({
    type: z.literal('reply_on_pr'),
    prNumber: z.number().int(),
    commentId: z.string().nullable().default(null),
    draft: z.string().min(1),
    resolve: z.boolean().default(false),
    originRef: z.string().nullable().default(null),
    ...base,
  }),
  z.object({
    type: z.literal('merge_pr'),
    prNumber: z.number().int(),
    method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
    ...base,
  }),
  z.object({
    type: z.literal('propose_plan'),
    planId: z.string().min(1),
    originRef: z.string().min(1),
    detail: z.string().min(1).nullable().default(null),
    caveats: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          detail: z.string().min(1).nullable().default(null),
        }),
      )
      .default([]),
    prompt: z.string().min(1),
    ...base,
  }),
  z.object({
    type: z.literal('propose_plan_amendment'),
    amendmentId: z.string().min(1),
    planId: z.string().min(1),
    originRef: z.string().min(1),
    prompt: z.string().min(1),
    ...base,
  }),
  z.object({
    type: z.literal('propose_shortfall'),
    originRef: z.string().min(1),
    issueNumber: z.number().int(),
    planId: z.string().min(1),
    cause: z.enum(['plan', 'part']),
    partSlug: z.string().min(1).nullable().default(null),
    summary: z.string().min(1),
    detail: z.string().min(1).nullable().default(null),
    prompt: z.string().min(1),
    ...base,
  }),
  z.object({
    type: z.literal('update_pr_branch'),
    prNumber: z.number().int(),
    base: z.string().min(1),
    branch: z.string().min(1),
    originRef: z.string().min(1),
    ...base,
  }),
  z.object({
    type: z.literal('requeue_ci_check'),
    prNumber: z.number().int(),
    checks: z.array(z.object({ name: z.string().min(1), requeueRef: z.string().min(1) })).min(1),
    originRef: z.string().min(1),
    ...base,
  }),
  z.object({
    type: z.literal('set_work_item_state'),
    number: z.number().int(),
    state: z.string().min(1),
    ...base,
  }),
  z.object({ type: z.literal('no_op'), ...base }),
]);

export type ValidatedAction = z.infer<typeof ActionSchema>;

export interface ParseResult {
  actions: ValidatedAction[];
  rejected: { raw: unknown; error: string }[];
}

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
