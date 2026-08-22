import { roundUsd } from '../issueSpend.js';
import { inWindow, type ResolvedWindow } from '../insightsWindow.js';

/**
 * What the injected block costs, in the dollars the rest of the cockpit uses
 * (issue #27 phase 7).
 *
 * The block is input the fleet pays for on work nobody asked it to do, and until
 * this existed the only number an operator had was a character count — which is a
 * measure of the cap and not of the money. This prices it against the same window
 * Insights measures everything else over ([18](../../docs/spec/18-observability.md#the-window)),
 * so the figure can be read beside the fleet's spend rather than only against
 * itself.
 *
 * ## Measured, not modelled — with one estimate, named
 *
 * Every dollar here is money the fleet actually reported: this takes the **share**
 * of the fleet's own input the block accounts for and applies it to the fleet's
 * own recorded spend. There is no price list in this repository and there must not
 * be one — a table of per-token prices is a second statement about money, free to
 * disagree with `costUsd` the moment a rate changes or a deployment runs on a
 * different plan, and it would disagree silently.
 *
 * Applying the fleet's own rate is also what keeps the figure honest about the
 * cache. The block lives in the system prompt precisely so it is a cached prefix,
 * and pricing it at a fresh-input rate would overstate it by roughly an order of
 * magnitude. `Agent.inputTokens` is the **gross** figure — fresh, written and read
 * — so `costUsd / inputTokens` is the fleet's own measured dollars per input
 * token with the cache discount already inside it. A fleet at a 90% hit rate
 * carries a low rate and the block inherits it; a fleet at 0% carries a high one
 * and the block inherits that. Nothing here has to know what a cache read costs.
 *
 * The one thing that is estimated is characters into tokens, and it cannot be
 * measured: nothing in the harness tokenises, and the block is never billed as a
 * line item. {@link KNOWLEDGE_CHARS_PER_TOKEN} is that estimate, stated once,
 * shipped on the reading so the page can say so, and the only number here a
 * reader should treat as approximate.
 *
 * ## Per turn, then divided by dispatches — not per launch
 *
 * The block is paid on **every turn of a session**, not once at launch. It sits in
 * the system prompt, and a session re-sends its whole prefix on every call — which
 * is why the prefix being cached is the point rather than an optimisation. The
 * denominator this is measured against (`Agent.inputTokens`) is likewise a sum
 * over every turn, so a numerator counted per *launch* would understate the block
 * by the fleet's average turn count — twenty-fold or worse — while looking like
 * the same arithmetic.
 *
 * So the block's tokens over the window are its tokens times the fleet's turns,
 * and "dollars per dispatch" is that total divided by the dispatches — which is
 * the number the page asks for, arrived at from the quantity that is actually
 * billed.
 *
 * → `docs/spec/27-knowledge.md#what-it-costs`
 */

/**
 * Characters per token, for the one conversion nothing here can measure.
 *
 * Four is the usual figure for English prose and markdown, which is what a claim
 * is. It is deliberately a constant rather than a config key: an operator tuning
 * it would be tuning the answer rather than the thing being measured, and a
 * second deployment's figure would then not be comparable with this one's.
 */
export const KNOWLEDGE_CHARS_PER_TOKEN = 4;

/** The agent fields this reads — a structural subset of `Agent`, so a row passes as one. */
interface CostedRun {
  startedAt: string;
  costUsd: number | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  numTurns: number | null;
}

/** What the block costs, and every number the page needs to say why. */
export interface KnowledgeCost {
  /** The window the reading was taken over, as the server resolved it. */
  windowLabel: string;
  /** The block as it will actually ship — `renderKnowledgeBlock`'s own string, never a recount. */
  blockChars: number;
  /** {@link blockChars} at {@link KNOWLEDGE_CHARS_PER_TOKEN}. The estimated half. */
  blockTokens: number;
  charsPerToken: number;
  /** Dispatches in the window whose usage the harness holds — the rows every figure below is drawn from. */
  launches: number;
  /**
   * Dispatches in the window that reported no usage at all, and are therefore in
   * none of the sums.
   *
   * Shipped rather than swallowed: a PTY deployment reports none, so a reading
   * that quietly counted only the measured runs would say the block costs almost
   * nothing on exactly the deployments where nothing is known. Null is unmeasured
   * and never free — `Agent.costUsd`'s own convention.
   */
  unmeasured: number;
  /** Turns across those dispatches: how many times the block was actually sent. */
  turns: number;
  /** The fleet's gross input over them — fresh, cache-written and cache-read alike. */
  inputTokens: number;
  /** The cache-read share of it, which is why the rate below is as low as it is. */
  cachedInputTokens: number;
  /** What those dispatches cost, as they reported it. */
  fleetCostUsd: number;
  /** The block's share of {@link inputTokens}, or null when nothing was measured. */
  shareOfInput: number | null;
  /** The block's dollars on one dispatch, or null when nothing was measured. */
  perDispatchUsd: number | null;
  /** Its dollars across the whole window, or null when nothing was measured. */
  windowCostUsd: number | null;
}

/**
 * Price the block over one window.
 *
 * Pure, and handed the block's own length rather than re-rendering it: what fits
 * is `renderKnowledgeBlock`'s answer and is never recomputed at a call site, and a
 * cost drawn from a second rendering would be a cost for a block that did not
 * ship.
 *
 * A run counts by **when it started**, not when it ended: the block was written
 * into its launch arguments at that moment, and a nine-hour agent that started
 * before the window did not pay for this window's block. That is deliberately the
 * opposite end from `runInstant`, which dates a run by its spend — money is spent
 * throughout a run, and a block is bought once at the top of it.
 */
export function knowledgeBlockCost(
  runs: readonly CostedRun[],
  blockChars: number,
  window: ResolvedWindow,
): KnowledgeCost {
  const started = runs.filter((run) => inWindow(window, Date.parse(run.startedAt)));
  // A run is measured only if all three are present. Turns matter as much as the
  // money here: without them the block's tokens cannot be counted against an input
  // total that is itself a sum over turns, and defaulting a missing count to one
  // would understate the block rather than declining to answer.
  const measured = started.filter(
    (run) => run.costUsd !== null && run.inputTokens !== null && run.inputTokens > 0 && (run.numTurns ?? 0) > 0,
  );
  const sum = (pick: (run: CostedRun) => number | null): number =>
    measured.reduce((total, run) => total + (pick(run) ?? 0), 0);
  const inputTokens = sum((run) => run.inputTokens);
  const fleetCostUsd = roundUsd(sum((run) => run.costUsd));
  const turns = sum((run) => run.numTurns);
  const blockTokens = Math.ceil(Math.max(0, blockChars) / KNOWLEDGE_CHARS_PER_TOKEN);
  const base = {
    windowLabel: window.label,
    blockChars,
    blockTokens,
    charsPerToken: KNOWLEDGE_CHARS_PER_TOKEN,
    launches: measured.length,
    unmeasured: started.length - measured.length,
    turns,
    inputTokens,
    cachedInputTokens: sum((run) => run.cacheReadTokens),
    fleetCostUsd,
  };
  // Nothing to divide by is "cannot say", not "free". The three readings that
  // depend on the fleet's own rate go null together, so a page drawing one of them
  // cannot draw a zero it would read as an answer.
  if (measured.length === 0 || inputTokens === 0) {
    return { ...base, shareOfInput: null, perDispatchUsd: null, windowCostUsd: null };
  }
  const shareOfInput = (blockTokens * turns) / inputTokens;
  const windowCostUsd = roundUsd(shareOfInput * fleetCostUsd);
  return {
    ...base,
    shareOfInput,
    windowCostUsd,
    // Divided here rather than in the browser, for the contradiction ratio's
    // reason: this is arithmetic over a share and a cost whose rule the view layer
    // does not know, and a second division there would be free to disagree with
    // the total drawn beside it.
    perDispatchUsd: roundUsd(windowCostUsd / measured.length),
  };
}
