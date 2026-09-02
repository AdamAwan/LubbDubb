import type { InsightsWindowView } from '../insightsWindow.js';
import type { ReviewAttention, ReviewIdea, ReviewMark, ReviewPackRecord, ReviewRange } from '../types.js';

/**
 * What the packs say about the agents that wrote them — the operator's reading,
 * and the only place anything aggregates across packs.
 *
 * Three readings, and they sit together because they are three answers to one
 * question: **is this subsystem's own output drifting?**
 *
 * - **The overrides.** A reviewer may relabel an idea the checker labelled, and
 *   the override is recorded and *never shown to the checker on a later pack* —
 *   given it, the checker would calibrate to what reviewers like rather than to
 *   what is risky. A pattern of upgrades says the checker is systematically
 *   underselling risk, and the fix is a person changing its prompt, once,
 *   deliberately. → `docs/spec/31-review-packs.md#attention`
 * - **The plumbing ratio.** `plumbing` is the honest answer to hunks that carry
 *   nothing to review, and it is also where an author puts anything it cannot be
 *   bothered to explain. The ratio of plumbing hunks to owned ones is the signal
 *   that it has started rotting. → `docs/spec/31-review-packs.md#coverage`
 * - **Prominence.** The four surface requirements a false claim makes are
 *   checkable as an order things are drawn in, and none of them measures whether
 *   a false claim gets *read*. A pull request that merged while a false claim on
 *   its pack was unmarked does.
 *   → `docs/spec/31-review-packs.md#whether-prominence-works`
 *
 * **Nothing here reaches an agent.** It is not a knowledge claim, it is not fed
 * back into a prompt, and it is never shown to the checker — a label that has
 * learned to agree with its reader has stopped being evidence. It is a page a
 * person reads and acts on.
 *
 * **Derived, never stored.** It folds `review_packs` and `review_marks`, both
 * durable and both dated; a table of pre-summed calibration would be a copy that
 * goes stale on the next mark.
 *
 * ## One population
 *
 * Every figure is over **each pull request's current pack, written in the
 * window** — one pack per pull request, so a pull request asked three times is
 * not counted three times, and the pack is the one the page draws. The marks laid
 * over it are every mark on that pull request whenever it was made, exactly as the
 * page lays them: a mark is keyed to a hunk, and the idea that owns that hunk now
 * is the idea the reviewer's label is about now.
 */
export interface ReviewCalibration {
  window: InsightsWindowView;
  /** How many packs the three readings are folded over, and how many pull requests they cover. */
  packs: number;
  overrides: ReviewOverrideReading;
  plumbing: ReviewPlumbingReading;
  prominence: ReviewProminenceReading;
}

/** Where reviewers disagree with the checker, and which way. */
export interface ReviewOverrideReading {
  /** Ideas the checker labelled and a reviewer could have relabelled — the denominator. */
  labelled: number;
  /** Of those, how many a reviewer relabelled. */
  overridden: number;
  /** Overrides toward more scrutiny. The count that says the checker undersells risk. */
  upgrades: number;
  /** Overrides toward less. */
  downgrades: number;
  /** Overrides onto or off `split`, which is a judgement about how ideas relate rather than a rung. */
  sideways: number;
  /** Every checker-label → reviewer-label pair that happened, commonest first. */
  pairs: ReviewOverridePair[];
}

export interface ReviewOverridePair {
  from: ReviewAttention;
  to: ReviewAttention;
  count: number;
}

/** How much of what the authors wrote they declined to explain. */
export interface ReviewPlumbingReading {
  /** Hunks owned across the population. */
  hunks: number;
  /** Of those, the ones the reserved `plumbing` idea owns. */
  plumbingHunks: number;
  /** `plumbingHunks / hunks`, or null where the population owns no hunk at all — never zero. */
  ratio: number | null;
  /** The packs with the most plumbing, worst first: where an operator looks. */
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

/** Whether the loudest thing on the page is getting read. */
export interface ReviewProminenceReading {
  /** Packs in the population carrying at least one false claim. */
  packsWithFalse: number;
  /** False claims across them. */
  falseClaims: number;
  /** Ideas carrying one, and how many of those a reader marked seen. */
  ideas: number;
  seen: number;
  /**
   * Pull requests that **merged** with a false claim nobody marked seen — the one
   * number that measures the four surface requirements, listed rather than
   * counted so an operator can go and look at each.
   */
  mergedUnseen: number[];
}

/** How much scrutiny each rung asks for. `split` is not on the ladder — it is a judgement about relatedness. */
const LADDER: Partial<Record<ReviewAttention, number>> = { skim: 1, decide: 2, read: 3 };

/** How many packs the "worst plumbing" list carries. Enough to act on; the ratio above it is the reading. */
const PLUMBING_ROWS = 5;

export function buildReviewCalibration(input: {
  /** Each pull request's current pack. Filtered to the window here, on `writtenAt`. */
  packs: readonly ReviewPackRecord[];
  /** Every mark on every pull request, whenever it was made. */
  marks: readonly ReviewMark[];
  /**
   * The pull requests the durable work graph says merged. Read off the graph
   * rather than the world, because the world drops a closed pull request after
   * `closedPrWindowMs` and this reading is about merges that already happened.
   */
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
      // Null and never zero on an empty population: *nothing has been authored*
      // must not read as *no author has reached for plumbing*.
      ratio: hunks === 0 ? null : plumbingHunks / hunks,
      worst: plumbingPacks
        .sort((a, b) => b.ratio - a.ratio || b.plumbingHunks - a.plumbingHunks)
        .slice(0, PLUMBING_ROWS),
    },
    prominence,
  };
}

/** The hunks an idea owns — the `hunk` anchors; a `region` is a reference, not ownership. */
function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

const hunkKey = (r: ReviewRange): string => `${r.path}:${r.start}-${r.end}`;

/**
 * What a reviewer did to one idea, by the same rule the page lays marks with
 * (`web/src/view/reviewPack.ts`): an idea wears an override only when **every**
 * hunk it owns agrees on one label, and is seen only when every hunk it owns is.
 * Across a rewrite that is the honest reading — the next pack may fold two ideas
 * into one, and calling the union marked because half of it was is the lie the
 * per-hunk key exists to avoid.
 *
 * Stated twice rather than shared, for the reason `KNOWN_REVIEW_PACK_SCHEMA` is:
 * `web/src/` may name no server module but `src/wire.ts`, which carries no
 * runtime, so there is no one place both can reach.
 */
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
