import { z } from 'zod';
import type { LocalValidationFinding } from '../../types.js';

// → docs/spec/32-local-validation.md

const FindingSchema = z
  .object(
    {
      title: z.string().trim().min(1, 'every finding needs a title'),
      detail: z.string().trim().min(1, 'every finding needs a detail — what you did and what happened'),
      severity: z.enum(['blocker', 'defect', 'nit'], {
        error: 'severity must be "blocker", "defect" or "nit"',
      }),
      url: z.string().trim().min(1).nullish(),
      screenshot: z
        .string()
        .trim()
        .min(1)
        .refine((name) => !/[\\/]/.test(name) && name !== '..', 'screenshot is a file name, not a path')
        .nullish(),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? 'a finding declares "title", "detail", "severity", and optionally "url" and "screenshot"'
          : undefined,
    },
  )
  .strict();

const ReportSchema = z
  .object(
    {
      result: z.enum(['passed', 'failed', 'blocked'], {
        error: 'result must be "passed", "failed" or "blocked"',
      }),
      summary: z
        .string({
          error: (issue) =>
            issue.input === undefined ? 'summary is required — say what you did and what you saw' : undefined,
        })
        .trim()
        .min(1, 'summary is required — say what you did and what you saw'),
      findings: z.array(FindingSchema).default([]),
      visited: z.array(z.string().trim().min(1)).default([]),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? 'a report declares "result", "summary", "findings" and "visited" — which validation is decided by what you were dispatched to run'
          : undefined,
    },
  )
  .strict();

type ParsedReport = z.infer<typeof ReportSchema>;

interface LocalValidationReport {
  result: 'passed' | 'failed' | 'blocked';
  summary: string;
  findings: LocalValidationFinding[];
  visited: string[];
}

export function validateLocalValidationReport(
  args: unknown,
): { ok: true; report: LocalValidationReport } | { ok: false; error: string } {
  const parsed = ReportSchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
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
