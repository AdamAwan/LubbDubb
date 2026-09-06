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

const ReportSchema = z
  .object({
    result: z.enum(['passed', 'failed', 'handback'], {
      required_error: 'result must be "passed", "failed" or "handback"',
      invalid_type_error: 'result must be "passed", "failed" or "handback"',
    }),
    note: z
      .string({ required_error: 'note is required — say what you saw', invalid_type_error: 'note is required' })
      .trim()
      .min(1, 'note is required — say what you saw'),
  })
  .strict('a report declares only "result" and "note" — which check is decided by what you were dispatched to run');

type ParsedReport = z.infer<typeof ReportSchema>;

export function validateReport(args: unknown): { ok: true; report: ParsedReport } | { ok: false; error: string } {
  const parsed = ReportSchema.safeParse(args);
  if (parsed.success) return { ok: true, report: parsed.data };
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
