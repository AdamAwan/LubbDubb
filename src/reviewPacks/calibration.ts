import type { InsightsWindowView } from '../insights/insightsWindow.js';
import type { ReviewAttention, ReviewIdea, ReviewMark, ReviewPackRecord, ReviewRange } from '../types.js';

// → docs/spec/31-review-packs.md

export interface ReviewCalibration {
  window: InsightsWindowView;
  packs: number;
  overrides: ReviewOverrideReading;
  plumbing: ReviewPlumbingReading;
  prominence: ReviewProminenceReading;
}

export interface ReviewOverrideReading {
  labelled: number;
  overridden: number;
  upgrades: number;
  downgrades: number;
  sideways: number;
  pairs: ReviewOverridePair[];
}

export interface ReviewOverridePair {
  from: ReviewAttention;
  to: ReviewAttention;
  count: number;
}

export interface ReviewPlumbingReading {
  hunks: number;
  plumbingHunks: number;
  ratio: number | null;
  worst: ReviewPlumbingPack[];
}

export interface ReviewPlumbingPack {
  prNumber: number;
  headSha: string;
  writtenAt: string;
  hunks: number;
  plumbingHunks: number;
  ratio: number;
}

export interface ReviewProminenceReading {
  packsWithFalse: number;
  falseClaims: number;
  ideas: number;
  seen: number;
  mergedUnseen: number[];
}

const LADDER: Partial<Record<ReviewAttention, number>> = { skim: 1, decide: 2, read: 3 };

const PLUMBING_ROWS = 5;

export function buildReviewCalibration(input: {
  packs: readonly ReviewPackRecord[];
  marks: readonly ReviewMark[];
  merged: ReadonlySet<number>;
  window: InsightsWindowView;
}): ReviewCalibration {
  const since = input.window.since;
  const packs = input.packs.filter((record) => since === null || record.writtenAt >= since);
  const marksByPr = new Map<number, Map<string, ReviewMark>>();
  for (const mark of input.marks) {
    const byHunk = marksByPr.get(mark.prNumber) ?? new Map<string, ReviewMark>();
    byHunk.set(hunkKey(mark.hunk), mark);
    marksByPr.set(mark.prNumber, byHunk);
  }

  const pairs = new Map<string, ReviewOverridePair>();
  const overrides: ReviewOverrideReading = {
    labelled: 0,
    overridden: 0,
    upgrades: 0,
    downgrades: 0,
    sideways: 0,
    pairs: [],
  };
  const plumbingPacks: ReviewPlumbingPack[] = [];
  let hunks = 0;
  let plumbingHunks = 0;
  const prominence: ReviewProminenceReading = {
    packsWithFalse: 0,
    falseClaims: 0,
    ideas: 0,
    seen: 0,
    mergedUnseen: [],
  };

  for (const { pack, writtenAt } of packs) {
    const byHunk = marksByPr.get(pack.prNumber) ?? new Map<string, ReviewMark>();
    let packHunks = 0;
    let packPlumbing = 0;
    let packFalse = 0;
    let packUnseen = false;
    for (const idea of pack.ideas) {
      const owned = ownedHunks(idea);
      packHunks += owned.length;
      if (idea.id === 'plumbing') packPlumbing += owned.length;

      const laid = lay(owned, byHunk);
      if (idea.attention !== null) {
        overrides.labelled += 1;
        if (laid.attention !== null && laid.attention !== idea.attention) {
          overrides.overridden += 1;
          count(pairs, idea.attention, laid.attention);
          const from = LADDER[idea.attention];
          const to = LADDER[laid.attention];
          if (from === undefined || to === undefined) overrides.sideways += 1;
          else if (to > from) overrides.upgrades += 1;
          else overrides.downgrades += 1;
        }
      }

      const wrong = idea.claims.filter((claim) => claim.verdict === 'false').length;
      if (wrong === 0) continue;
      packFalse += wrong;
      prominence.ideas += 1;
      if (laid.seen) prominence.seen += 1;
      else packUnseen = true;
    }
    hunks += packHunks;
    plumbingHunks += packPlumbing;
    if (packPlumbing > 0) {
      plumbingPacks.push({
        prNumber: pack.prNumber,
        headSha: pack.headSha,
        writtenAt,
        hunks: packHunks,
        plumbingHunks: packPlumbing,
        ratio: packHunks === 0 ? 1 : packPlumbing / packHunks,
      });
    }
    if (packFalse > 0) {
      prominence.packsWithFalse += 1;
      prominence.falseClaims += packFalse;
      if (packUnseen && input.merged.has(pack.prNumber)) prominence.mergedUnseen.push(pack.prNumber);
    }
  }

  overrides.pairs = [...pairs.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
  prominence.mergedUnseen.sort((a, b) => a - b);
  return {
    window: input.window,
    packs: packs.length,
    overrides,
    plumbing: {
      hunks,
      plumbingHunks,
      ratio: hunks === 0 ? null : plumbingHunks / hunks,
      worst: plumbingPacks
        .sort((a, b) => b.ratio - a.ratio || b.plumbingHunks - a.plumbingHunks)
        .slice(0, PLUMBING_ROWS),
    },
    prominence,
  };
}

function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

const hunkKey = (r: ReviewRange): string => `${r.path}:${r.start}-${r.end}`;

function lay(
  owned: ReviewRange[],
  byHunk: ReadonlyMap<string, ReviewMark>,
): { attention: ReviewAttention | null; seen: boolean } {
  if (owned.length === 0) return { attention: null, seen: false };
  const own = owned.map((h) => byHunk.get(hunkKey(h)) ?? null);
  const first = own[0]?.attention ?? null;
  const attention = first !== null && own.every((m) => m !== null && m.attention === first) ? first : null;
  return { attention, seen: own.every((m) => m !== null && m.seen) };
}

function count(pairs: Map<string, ReviewOverridePair>, from: ReviewAttention, to: ReviewAttention): void {
  const key = `${from}>${to}`;
  const pair = pairs.get(key) ?? { from, to, count: 0 };
  pair.count += 1;
  pairs.set(key, pair);
}
