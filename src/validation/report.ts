import { z } from 'zod';
import type { ValidationCheck } from '../types.js';
import { validateOriginParts } from './fleet.js';

// → docs/spec/20-validation.md

export function validationReportTarget(
  originRef: string | null,
): { ok: true; issueNumber: number; checkId: string } | { ok: false; error: string } {
  const target = validateOriginParts(originRef);
  if (target) return { ok: true, ...target };
  const ref = originRef ?? '';
  return {
    ok: false,
    error:
      `validation_report records the reading of one validation check, and only the agent dispatched to run that ` +
      `check may record it. This task's origin is ${ref || '(none)'}, not issue:<n>:validate:<checkId>. ` +
      `If you believe a check is wrong — it names a screen that moved, or a command that was renamed — correct ` +
      `its wording with validation_amend instead; that is open to every agent working the goal. A check nobody ` +
      `sent you to run is not one you can have run.`,
  };
}

/**
 * A capture is a **file name** in the goal's validation directory, never a path and never a URL. It
 * is the resource name's own rule, and for the resource name's reason: a name cannot escape the
 * directory it is resolved against, so nothing downstream has to prove that it did not.
 */
const CaptureName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^/\\]+$/, 'a capture is a file name in the check\u2019s own directory, not a path')
  .refine((name) => name !== '.' && name !== '..', 'a capture is a file name, not a path');

export const ReportSchema = z
  .object({
    result: z
      .enum(['passed', 'failed', 'blocked', 'captured'], {
        required_error: 'result must be "passed", "failed", "captured" or "blocked"',
        invalid_type_error: 'result must be "passed", "failed", "captured" or "blocked"',
      })
      .describe(
        '"passed" — you followed the procedure and saw what it expects. "failed" — you followed it and did ' +
          'not; a real finding about the goal. "captured" — the plan asked you to hand a screen back: you took ' +
          'the picture and a person judges it, so you state no outcome at all. "blocked" — you could not run ' +
          'it, so nothing is recorded and a person gets it back.',
      ),
    capture: CaptureName.describe(
      'The screenshot you wrote into the check’s own directory, by file name. Required with "captured", and ' +
        'required with "passed" on a check that declares `proof` — there the image is the evidence its author ' +
        'demanded in advance, and the pass is refused without it. Accepted with nothing else. It outlives the ' +
        'run, because somebody still has to be able to look at it.',
    ).optional(),
    note: z
      .string({ required_error: 'note is required — say what you saw', invalid_type_error: 'note is required' })
      .trim()
      .min(1, 'note is required — say what you saw')
      .describe(
        'What you actually saw, or what stopped you. This is the whole of what an operator reads later ' +
          'instead of running the check again, so "passed" is not a note.',
      ),
  })
  .strict(
    'a report declares only "result", "note" and — with "captured" — "capture"; which check is decided by what ' +
      'you were dispatched to run',
  )
  .superRefine((report, ctx) => {
    if (report.result === 'captured' && report.capture === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capture'],
        message: 'a "captured" report names the screenshot it took — without one there is nothing to look at',
      });
  });

type ParsedReport = z.infer<typeof ReportSchema>;

/**
 * `handback` was this verdict's name until the three validation paths were given one word for it. A
 * word withdrawn from a tool contract is answered with a refusal that points at what replaced it,
 * `RETIRED_TOOL_NAMES`' rule one layer down: the templates that carry the word are
 * operator-overridable, so the deployments that customised most are exactly the ones that still say
 * it, and a generic enum rejection leaves an agent guessing at which of four words it wanted.
 */
const RETIRED_RESULT = 'handback';

/**
 * Whether this check refuses a pass that hands nothing back. `proof` is the author's demand, written
 * before the run and read here — which is the whole of what separates it from an agent volunteering
 * an image beside its own green row. That direction is the one the capture rule was written against,
 * and it is why a capture may ride a `passed` here and nowhere else.
 * → docs/spec/20-validation.md#proof
 */
export function demandsProof(check: Pick<ValidationCheck, 'proof'>): boolean {
  return check.proof !== null && check.proof.trim() !== '';
}

/**
 * The cross-field rule the pure schema cannot hold, because it turns on the **check** rather than on
 * the report: which results a capture may ride, and which result may not arrive without one. Null is
 * a report that satisfies it.
 */
function captureFault(report: ParsedReport, check: Pick<ValidationCheck, 'proof'> | null): string | null {
  const demanded = check !== null && demandsProof(check);
  if (report.result === 'passed' && demanded && report.capture === undefined)
    return (
      'this check declares "proof" — the evidence its author demanded before anybody ran it — so a pass names ' +
      'the screenshot that shows it. Write the image into the check’s own directory and name it in ' +
      '"capture", or report what you actually saw: "failed" if it was wrong, "blocked" if you could not get ' +
      'to it. A pass on your word alone is the one thing this check was written to refuse.'
    );
  if (report.capture !== undefined && report.result !== 'captured' && !(report.result === 'passed' && demanded))
    return (
      '"capture" belongs to a "captured" report, or to a pass on a check that declares "proof". A screenshot ' +
      'asserts nothing, so it never rides a result that does unless the check asked for it in advance — an ' +
      'image volunteered beside a pass reads as the evidence for it, and nobody looked.'
    );
  return null;
}

export function validateReport(
  args: unknown,
  check: Pick<ValidationCheck, 'proof'> | null = null,
): { ok: true; report: ParsedReport } | { ok: false; error: string } {
  if (typeof args === 'object' && args !== null && (args as { result?: unknown }).result === RETIRED_RESULT)
    return {
      ok: false,
      error:
        'report "blocked" rather than "handback" — the verdict was renamed, and "blocked" is now the one word ' +
        'every validation path takes for a check an agent could not carry out. Nothing was recorded. Call again ' +
        'with the same note and result "blocked".',
    };
  const parsed = ReportSchema.safeParse(args);
  if (parsed.success) {
    const fault = captureFault(parsed.data, check);
    return fault === null ? { ok: true, report: parsed.data } : { ok: false, error: fault };
  }
  const first = parsed.error.errors[0];
  return { ok: false, error: first ? first.message : 'the report could not be read' };
}

export function amendedSinceRunBegan(check: ValidationCheck, since: string | null): boolean {
  return since !== null && check.amendedAt !== null && check.amendedAt > since;
}

export function amendedReportReason(check: ValidationCheck): string {
  const note = check.amendNote === null ? '' : ` The amendment says "${check.amendNote}".`;
  return (
    `This check was reworded by an amendment while you were running it.${note} Nothing was recorded. ` +
    'Re-read the current check and claim it again before running it.'
  );
}

export function handbackReason(reason: string, by: 'agent' | 'desktop'): string {
  const who = by === 'desktop' ? 'A desktop session' : 'An agent';
  return `${who} could not run this check: ${reason}`;
}
