import { createHash } from 'node:crypto';
import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';

// → docs/spec/14-persistence.md

/* Two sentences of lede and a handful of short bullets under it. The caps were
   1200 and 2000, which is four paragraphs — long enough that the board's one
   piece of prose became the thing a reader skipped. → docs/spec/17-cockpit.md#the-feature-summary */
/** A headline is repeated out loud, so it is a clause and not a sentence. */
const MAX_HEADLINE = 90;
const MAX_STANDING = 360;

const MAX_SECTION = 600;

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
  headline: string | null;
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
      error:
        `standing is too long (${standing.length} chars, max ${MAX_STANDING}). It is two sentences: what works ` +
        `and what it is waiting on. The bullets below it carry the detail.`,
    };
  }
  // Refused above the cap rather than clipped, for `standing`'s reason one field up:
  // half a headline is not a shorter headline, it is a different claim.
  const headline = text(args.headline);
  if (headline !== null && headline.length > MAX_HEADLINE) {
    return {
      ok: false,
      error:
        `headline is too long (${headline.length} chars, max ${MAX_HEADLINE}). It is the half-sentence somebody ` +
        `repeats when asked how this is going — "most of the way there, nothing on live yet". The detail is ` +
        `standing's.`,
    };
  }
  const sections = [text(args.usable), text(args.blocked), text(args.remaining)];
  const trimmed = sections.some((s) => s !== null && s.length > MAX_SECTION);
  const [usable = null, blocked = null, remaining = null] = sections.map(clip);
  return { ok: true, input: { headline, standing, usable, blocked, remaining }, trimmed };
}

/* Cut at a line boundary where there is one: the sections are drawn as bullets,
   and a slice taken mid-word leaves half a bullet on the card. */
function clip(section: string | null): string | null {
  if (section === null || section.length <= MAX_SECTION) return section;
  const cut = section.slice(0, MAX_SECTION);
  const lastLine = cut.lastIndexOf('\n');
  return (lastLine > 0 ? cut.slice(0, lastLine) : cut).trimEnd();
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
