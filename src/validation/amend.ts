import { z } from 'zod';
import { ValidationCheckSchema, ValidationResourceSchema } from './checkDocument.js';

/**
 * The `validation_amend` tool's pure layer: who may correct a goal's validation
 * plan, what a correction is allowed to say, and how the change is worded to the
 * operator who reads it afterwards.
 *
 * ## Why a validation plan has to be correctable at all
 *
 * It is written by the one agent that has **not done the work yet**. A planner
 * reading the repository writes a check against the code it expects to exist, and
 * by the second part that check is describing a screen that moved, a command that
 * was renamed, or a behaviour the plan decided against. A check set that can only
 * be rewritten by a full replan therefore goes stale exactly when somebody is
 * about to rely on it — which is worse than having no checks, because a stale
 * check that fails reads as a broken goal.
 *
 * ## Why it is a separate tool from `plan_submit`
 *
 * `plan_submit` takes a document that speaks for the **whole** plan: its
 * `validation` block declares the entire check set, so a check it omits was
 * withdrawn. That is the right reading for a planner and the wrong one for an
 * agent halfway through part three, which knows about one check and nothing about
 * the other eight. Handing that agent the whole-set transport would mean a
 * correction it wrote correctly and tersely silently deletes the rest of the
 * plan.
 *
 * So an amendment is **merge-only and says what it withdraws**. It is the same
 * split `note_progress` makes against `conclude_work`: a narrow, frequent,
 * additive act kept apart from the one that speaks for everything.
 */

/** As many checks as one correction may carry. A correction is not a replan. */
const MAX_AMENDED_CHECKS = 10;

/** Same bound, same argument, for the resources they name. */
const MAX_AMENDED_RESOURCES = 10;

/**
 * Which goal an agent may amend the validation plan of — its own, and only its
 * own.
 *
 * Deliberately **wider than the other origin fences**, and the width is the
 * point: `conclusionOrigin` and `partConclusionOrigin` refuse every caller but
 * one because a conclusion is a verdict that only one party is entitled to cast.
 * A validation check is not a verdict; it is a note about how the goal gets
 * checked, and the agent best placed to notice that a check is wrong is whoever
 * is currently looking at the code. So any agent working *this* goal qualifies —
 * the whole-issue agent, a part agent, the assessor.
 *
 * The fence that still matters is unchanged and structural: the origin comes off
 * the credential, so an agent working goal A cannot amend goal B by asking.
 *
 * The planner is the one refusal, and by name rather than by scope: it already
 * has a transport that declares the entire block, and letting it use both would
 * be two ways to say one thing that disagree on what an omission means.
 */
export function validationAmendIssue(
  originRef: string | null,
): { ok: true; issueNumber: number } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+)(?::(.+))?$/.exec(ref);
  if (!match) {
    return {
      ok: false,
      error:
        `validation_amend corrects the validation plan of the goal you are working on, and this task's ` +
        `origin is ${ref || '(none)'}, which names no issue.`,
    };
  }
  if (match[2] === 'plan') {
    return {
      ok: false,
      error:
        `You are planning issue #${match[1]}, so the validation plan is yours to *write*, not to amend. ` +
        `Declare the whole thing in plan_submit's "validation" block — that transport speaks for the entire ` +
        `check set, which is what a planner is entitled to do and an agent halfway through a part is not.`,
    };
  }
  return { ok: true, issueNumber: Number(match[1]) };
}

const WithdrawSchema = z.object({
  id: z.string().min(1),
  reason: z
    .string({ required_error: 'a withdrawal needs a reason', invalid_type_error: 'a withdrawal needs a reason' })
    .trim()
    .min(1, 'a withdrawal needs a reason'),
});

/**
 * What one correction may say.
 *
 * `checks` reuses the plan document's own check schema rather than restating it,
 * so the two transports refuse the same things — including the `actor` field,
 * which both refuse rather than drop. A second copy would have drifted the first
 * time either learned a field.
 */
const AmendmentSchema = z
  .object({
    /**
     * Required, and the reason it is: this note is the whole of what an operator
     * sees when a check they read yesterday says something else today. `conclude_work`'s
     * rule — a state an operator acts on must not be one with no account of itself.
     */
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
      // Refused rather than resolved in one direction or the other, because both
      // readings are defensible and the caller means one of them. The store's
      // withdrawal arm relies on this: it may then assume a declared id is never
      // also a withdrawn one.
      if (ids.has(id)) add(`"${id}" is both declared and withdrawn — say one or the other`, 'withdraw');
    }
    // An amendment that changes nothing is not a no-op worth accepting silently:
    // the caller believes it corrected something, and would go on believing it.
    if (amendment.checks.length === 0 && amendment.withdraw.length === 0) {
      add('an amendment must declare at least one check or withdraw one', 'checks');
    }
  });

/** A parsed correction, before the store gives its new checks their letters and positions. */
type ParsedAmendment = z.infer<typeof AmendmentSchema>;

/**
 * Parse a correction, handing the reason back rather than throwing.
 *
 * Nothing is written on a rejection, `plan_submit`'s rule: the caller retries
 * against an unchanged check set instead of a half-applied one.
 */
export function validateAmendment(
  args: Record<string, unknown>,
): { ok: true; amendment: ParsedAmendment } | { ok: false; error: string } {
  const parsed = AmendmentSchema.safeParse(args);
  if (parsed.success) return { ok: true, amendment: parsed.data };
  const first = parsed.error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return { ok: false, error: `${where}${first?.message ?? 'invalid amendment'}` };
}

/**
 * How an amendment is worded on the check it changed.
 *
 * **Attributed and quoted**, `outstandingWorkNote`'s discipline for its reason: an
 * operator reading a band must not mistake an agent's account of why a check
 * changed for the harness's own statement that it needed to.
 */
export function amendmentNote(note: string): string {
  return `An agent working this goal amended the validation plan: ${note}`;
}

/** The same attribution for a check an agent withdrew, which is read where a superseded check's reason is. */
export function withdrawalReason(reason: string): string {
  return `An agent working this goal withdrew this check: ${reason}`;
}
