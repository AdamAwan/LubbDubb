import { z } from 'zod';
import type { ValidationCheck } from '../types.js';

// → docs/spec/20-validation.md

const CheckRefSchema = z.object({
  issue: z
    .number({
      required_error: 'issue is required — the goal number, e.g. 284',
      invalid_type_error: 'issue must be a number',
    })
    .int()
    .positive(),
  check: z
    .string({ required_error: 'check is required — a letter like "C", or the check id' })
    .trim()
    .min(1, 'check is required — a letter like "C", or the check id'),
});

type DesktopCheckRef = z.infer<typeof CheckRefSchema>;

export function desktopIssueRef(args: unknown): { ok: true; issue: number } | { ok: false; error: string } {
  const parsed = CheckRefSchema.pick({ issue: true }).safeParse(args);
  if (parsed.success) return { ok: true, issue: parsed.data.issue };
  const first = parsed.error.errors[0];
  return { ok: false, error: first ? first.message : 'the issue could not be read' };
}

export function desktopCheckRef(args: unknown): { ok: true; ref: DesktopCheckRef } | { ok: false; error: string } {
  const parsed = CheckRefSchema.safeParse(args);
  if (parsed.success) return { ok: true, ref: parsed.data };
  const first = parsed.error.errors[0];
  return { ok: false, error: first ? first.message : 'the check could not be read' };
}

export function findCheckByRef(checks: ValidationCheck[], ref: string): ValidationCheck | null {
  const wanted = ref.trim();
  return (
    checks.find((c) => c.id === wanted) ?? checks.find((c) => c.letter.toLowerCase() === wanted.toLowerCase()) ?? null
  );
}

export function claimStaleBefore(now: string, minutes: number): string {
  return new Date(new Date(now).getTime() - Math.max(1, minutes) * 60_000).toISOString();
}

export function claimIsLive(check: ValidationCheck, now: string, minutes: number): boolean {
  if (check.claimedBy === null || check.claimedAt === null) return false;
  return check.claimedAt > claimStaleBefore(now, minutes);
}

export function withLiveClaim(check: ValidationCheck, now: string, minutes: number): ValidationCheck {
  if (check.claimedBy === null || claimIsLive(check, now, minutes)) return check;
  return { ...check, claimedBy: null, claimedAt: null };
}

interface DesktopCheckSummary {
  letter: string;
  id: string;
  title: string;
  state: string;
  actor: string;
  result: { note: string | null; by: string | null } | null;
  amended: string | null;
  handback: string | null;
  claimedBy: string | null;
}

export function desktopCheckSummary(check: ValidationCheck, now: string, minutes: number): DesktopCheckSummary {
  return {
    letter: check.letter,
    id: check.id,
    title: check.title,
    state: check.state,
    actor: check.actor,
    result: check.state === 'unrun' ? null : { note: check.resultNote, by: check.resultBy },
    amended: check.amendedAt === null ? null : check.amendNote,
    handback: check.actor === 'fleet' ? null : check.handbackNote,
    claimedBy: claimIsLive(check, now, minutes) ? check.claimedBy : null,
  };
}
