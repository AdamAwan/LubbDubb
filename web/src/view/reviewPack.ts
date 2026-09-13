import type { ReviewAttention, ReviewIdea, ReviewMark, ReviewPack, ReviewPackPayload, ReviewRange } from '../types.js';

// → docs/spec/17-cockpit.md

/**
 * The derivations both renderings read, re-exported from the contract rather than
 * restated here: they are one copy, in `src/reviewPacks/derive.ts`, reached through
 * `src/wire.ts` — the one server module the cockpit may name.
 * → docs/spec/31-review-packs.md#one-copy-of-the-derivations
 */
export {
  anchorWeight,
  codeBlockLines,
  codeLanguage,
  falseClaims,
  highlightCode,
  ideaAtom,
  ideaFlags,
  numberIdeas,
  packFacts,
  plainSummary,
  shortSha,
  splitBody,
  testScenarios,
} from '../../../src/wire.js';
export type { FalseClaim, NumberedIdea } from '../../../src/wire.js';

export const KNOWN_REVIEW_PACK_SCHEMA = 1;

export interface IdeaMarks {
  read: boolean;
  attention: ReviewAttention | null;
  seen: boolean;
}

function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

const hunkKey = (r: ReviewRange): string => `${r.path}:${r.start}-${r.end}`;

export function layMarks(pack: ReviewPack, marks: readonly ReviewMark[]): Map<string, IdeaMarks> {
  const byHunk = new Map(marks.map((m) => [hunkKey(m.hunk), m]));
  const laid = new Map<string, IdeaMarks>();
  for (const idea of pack.ideas) {
    const hunks = ownedHunks(idea);
    const own = hunks.map((h) => byHunk.get(hunkKey(h)) ?? null);
    const read = hunks.length > 0 && own.every((m) => m !== null && m.read);
    const seen = hunks.length > 0 && own.every((m) => m !== null && m.seen);
    const first = own[0]?.attention ?? null;
    const attention =
      hunks.length > 0 && first !== null && own.every((m) => m !== null && m.attention === first) ? first : null;
    laid.set(idea.id, { read, attention, seen });
  }
  return laid;
}

type PackStanding = 'unchecked' | 'checking' | 'checked';

export function packStanding(payload: Pick<ReviewPackPayload, 'pack' | 'checking'>): PackStanding {
  if (payload.pack.order.length > 0) return 'checked';
  return payload.checking ? 'checking' : 'unchecked';
}

type PackCurrency =
  | { kind: 'current' }
  | { kind: 'stale'; headSha: string; commitsBehind: number | null }
  | { kind: 'gone' };

export function packCurrency(payload: Pick<ReviewPackPayload, 'head' | 'stale'>): PackCurrency {
  if (payload.head === null) return { kind: 'gone' };
  if (payload.stale === null) return { kind: 'current' };
  return { kind: 'stale', headSha: payload.stale.headSha, commitsBehind: payload.stale.commitsBehind };
}

export const ALL_IDEAS = 'all';

export function ideaOpen(openIdea: string | null, id: string): boolean {
  return openIdea === ALL_IDEAS || openIdea === id;
}
