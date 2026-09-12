import { createHash } from 'node:crypto';
import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';

// → docs/spec/14-persistence.md

const MAX_STANDING = 1_200;

const MAX_SECTION = 2_000;

export function featureSummaryOrigin(featureNumber: number): string {
  return issueOriginRef('summary', featureNumber);
}

export function featureSummarySubmitOrigin(
  originRef: string | null,
): { ok: true; featureOrigin: string; featureNumber: number } | { ok: false; error: string } {
  const number = issueOriginNumber('summary', originRef);
  if (number !== null) {
    return { ok: true, featureOrigin: issueOriginRef('root', number), featureNumber: number };
  }
  return {
    ok: false,
    error:
      `feature_summary is only for the agent dispatched to summarise a Feature, and this task's origin ` +
      `is ${originRef ?? '(none)'}. If you were sent to write up a goal that has been delivered, use ` +
      `retro_submit; if you are finishing work on an issue, use conclude_work.`,
  };
}

export interface FeatureSummaryInput {
  standing: string;
  usable: string | null;
  blocked: string | null;
  remaining: string | null;
}

export function validateFeatureSummary(
  args: Record<string, unknown>,
): { ok: true; input: FeatureSummaryInput; trimmed: boolean } | { ok: false; error: string } {
  const standing = text(args.standing);
  if (!standing) {
    return {
      ok: false,
      error:
        'standing is required: two or three sentences saying where this Feature actually is — what ' +
        'works, what it is waiting on, and what a reader should take away. It is the whole of what the ' +
        'card shows before anything is opened.',
    };
  }
  if (standing.length > MAX_STANDING) {
    return {
      ok: false,
      error: `standing is too long (${standing.length} chars, max ${MAX_STANDING}). The sections below it carry the detail.`,
    };
  }
  const sections = [text(args.usable), text(args.blocked), text(args.remaining)];
  const trimmed = sections.some((s) => s !== null && s.length > MAX_SECTION);
  const [usable = null, blocked = null, remaining = null] = sections.map((s) =>
    s === null ? null : s.slice(0, MAX_SECTION),
  );
  return { ok: true, input: { standing, usable, blocked, remaining }, trimmed };
}

function text(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

export interface FeatureChildStandingFacts {
  number: number;
  state: string;
  workItemState: string | null;
  deliveredAt: string | null;
  shortfallAt: string | null;
  runningSince: string | null;
  landedAt: string | null;
}

export function featureStandingKey(children: readonly FeatureChildStandingFacts[]): string {
  const lines = children
    .map((c) =>
      [
        c.number,
        c.state,
        c.workItemState ?? '',
        c.deliveredAt ?? '',
        c.shortfallAt ?? '',
        c.runningSince ?? '',
        c.landedAt ?? '',
      ].join(' '),
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}
