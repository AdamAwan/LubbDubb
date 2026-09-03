import { z } from 'zod';
import type { LocalValidationFinding } from '../types.js';

/**
 * What `local_validation_report` accepts, and the one refusal that is about the
 * shape of an answer rather than about its fields.
 *
 * Pure, so both the tool and its tests read the same schema — `validateReport`'s
 * arrangement one feature over.
 */

const FindingSchema = z
  .object({
    title: z.string().trim().min(1, 'every finding needs a title'),
    detail: z.string().trim().min(1, 'every finding needs a detail — what you did and what happened'),
    severity: z.enum(['blocker', 'defect', 'nit'], {
      required_error: 'severity must be "blocker", "defect" or "nit"',
      invalid_type_error: 'severity must be "blocker", "defect" or "nit"',
    }),
    url: z.string().trim().min(1).nullish(),
    // A file name, never a path — the bytes are in the directory you were given, and
    // the name is what joins this finding to the picture the cockpit draws.
    screenshot: z
      .string()
      .trim()
      .min(1)
      .refine((name) => !/[\\/]/.test(name) && name !== '..', 'screenshot is a file name, not a path')
      .nullish(),
  })
  .strict('a finding declares "title", "detail", "severity", and optionally "url" and "screenshot"');

const ReportSchema = z
  .object({
    result: z.enum(['passed', 'failed', 'blocked'], {
      required_error: 'result must be "passed", "failed" or "blocked"',
      invalid_type_error: 'result must be "passed", "failed" or "blocked"',
    }),
    // Required on all three arms, `validation_report`'s rule: a reading somebody
    // acts on later must not be a state with no account of itself, and a `blocked`
    // with no reason is indistinguishable from an agent that gave up.
    summary: z
      .string({ required_error: 'summary is required — say what you did and what you saw' })
      .trim()
      .min(1, 'summary is required — say what you did and what you saw'),
    findings: z.array(FindingSchema).default([]),
    visited: z.array(z.string().trim().min(1)).default([]),
  })
  .strict(
    'a report declares "result", "summary", "findings" and "visited" — which validation is decided by what you were dispatched to run',
  );

type ParsedReport = z.infer<typeof ReportSchema>;

interface LocalValidationReport {
  result: 'passed' | 'failed' | 'blocked';
  summary: string;
  findings: LocalValidationFinding[];
  visited: string[];
}

/**
 * Read a report, or say in one sentence why it could not be read.
 *
 * **A failure with nothing found is refused**, and that is the schema's one
 * judgement rather than a field check. The two answers mean different things and
 * only one of them schedules work: `failed` says the delivered behaviour is wrong
 * and dispatches an agent to fix it, so a `failed` with no finding would put an
 * agent on a branch with nothing to tell it what to change. An agent that ran the
 * plan and could not say what was wrong is describing a run it could not complete,
 * which is what `blocked` is for — and the refusal says so, rather than leaving the
 * caller to guess which of the three it wanted.
 */
export function validateLocalValidationReport(
  args: unknown,
): { ok: true; report: LocalValidationReport } | { ok: false; error: string } {
  const parsed = ReportSchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return { ok: false, error: first ? first.message : 'the report could not be read' };
  }
  const data: ParsedReport = parsed.data;
  if (data.result === 'failed' && data.findings.length === 0)
    return {
      ok: false,
      error:
        'a "failed" report needs at least one finding — an agent is dispatched to fix what you list, and it ' +
        'cannot act on a verdict with nothing in it. If you could not get far enough to say what is wrong, ' +
        'report "blocked" and say what stopped you.',
    };
  return {
    ok: true,
    report: {
      result: data.result,
      summary: data.summary,
      findings: data.findings.map((finding) => ({
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        url: finding.url ?? null,
        screenshot: finding.screenshot ?? null,
      })),
      visited: data.visited,
    },
  };
}
