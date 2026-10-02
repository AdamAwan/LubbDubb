import { buildAskQueue, type AskInputs } from '../../src/asks/queue.js';
import type { SetupReading } from '../../src/setup/reading.js';
import { needsYouOf, type AppliedFix, type NeedRow } from '../../web/src/view/needsYou.js';

/**
 * The rail's rows for a hand-built state: the server's queue through the cockpit's own filter, which
 * is the whole of what a browser does with `/api/state`'s `asks`.
 */
export function askRows(
  state: AskInputs,
  setup: SetupReading | null = null,
  applied: readonly AppliedFix[] = [],
  nowIso?: string,
): NeedRow[] {
  return needsYouOf(buildAskQueue(state, setup, nowIso), applied);
}

/** A hand-built state with the queue the server would have shipped beside it. */
export function withAsks<T extends AskInputs>(state: T, setup: SetupReading | null = null, nowIso?: string): T {
  return { ...state, asks: buildAskQueue(state, setup, nowIso) };
}
