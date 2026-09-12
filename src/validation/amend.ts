import { z } from 'zod';
import { issueOriginHead, issueOriginNumber } from '../issueOrigins.js';
import { ValidationCheckSchema, ValidationResourceSchema } from './checkDocument.js';

// → docs/spec/20-validation.md

const MAX_AMENDED_CHECKS = 10;

const MAX_AMENDED_RESOURCES = 10;

export function validationAmendIssue(
  originRef: string | null,
): { ok: true; issueNumber: number } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const head = issueOriginHead(ref);
  if (head === null) {
    return {
      ok: false,
      error:
        `validation_amend corrects the validation plan of the goal you are working on, and this task's ` +
        `origin is ${ref || '(none)'}, which names no issue.`,
    };
  }
  // The refusal moved with the authoring. It named the `:plan` origin while a planner wrote the check
  // set; the validation planner writes it now, and it has a transport that speaks for the whole set.
  // Two ways to say one thing that disagree about what an omission means is the drift the split
  // exists to prevent. → docs/spec/20-validation.md#validation_amend
  if (issueOriginNumber('validationPlan', ref) !== null) {
    return {
      ok: false,
      error:
        `You are writing the validation plan for issue #${head.issueNumber}, so the check set is yours to *write*, ` +
        `not to amend. Declare the whole thing in one validation_plan call — that transport speaks for the ` +
        `entire check set, which is what the validation planner is entitled to do and an agent halfway ` +
        `through a part is not.`,
    };
  }
  return { ok: true, issueNumber: head.issueNumber };
}

const WithdrawSchema = z.object({
  id: z.string().min(1),
  reason: z
    .string({ required_error: 'a withdrawal needs a reason', invalid_type_error: 'a withdrawal needs a reason' })
    .trim()
    .min(1, 'a withdrawal needs a reason'),
});

const AmendmentSchema = z
  .object({
    note: z
      .string({
        required_error: 'note is required — say why the validation plan is changing',
        invalid_type_error: 'note is required — say why the validation plan is changing',
      })
      .trim()
      .min(1, 'note is required — say why the validation plan is changing'),
    checks: z
      .array(ValidationCheckSchema)
      .default([])
      .transform((list) => (list.length > MAX_AMENDED_CHECKS ? list.slice(0, MAX_AMENDED_CHECKS) : list)),
    withdraw: z.array(WithdrawSchema).default([]),
    resources: z
      .array(ValidationResourceSchema)
      .default([])
      .transform((list) => (list.length > MAX_AMENDED_RESOURCES ? list.slice(0, MAX_AMENDED_RESOURCES) : list)),
  })
  .strict('an amendment declares only "note", "checks", "withdraw" and "resources"')
  .superRefine((amendment, ctx) => {
    const add = (message: string, path: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const ids = new Set<string>();
    for (const check of amendment.checks) {
      if (ids.has(check.id)) add(`duplicate check id "${check.id}"`, 'checks');
      ids.add(check.id);
    }
    const names = new Set<string>();
    for (const resource of amendment.resources) {
      if (names.has(resource.name)) add(`duplicate resource "${resource.name}"`, 'resources');
      names.add(resource.name);
    }
    for (const { id } of amendment.withdraw) {
      if (ids.has(id)) add(`"${id}" is both declared and withdrawn — say one or the other`, 'withdraw');
    }
    if (amendment.checks.length === 0 && amendment.withdraw.length === 0) {
      add('an amendment must declare at least one check or withdraw one', 'checks');
    }
  });

type ParsedAmendment = z.infer<typeof AmendmentSchema>;

export function validateAmendment(
  args: Record<string, unknown>,
): { ok: true; amendment: ParsedAmendment } | { ok: false; error: string } {
  const parsed = AmendmentSchema.safeParse(args);
  if (parsed.success) return { ok: true, amendment: parsed.data };
  const first = parsed.error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return { ok: false, error: `${where}${first?.message ?? 'invalid amendment'}` };
}

export function amendmentNote(note: string): string {
  return `An agent working this goal amended the validation plan: ${note}`;
}

export function withdrawalReason(reason: string): string {
  return `An agent working this goal withdrew this check: ${reason}`;
}
