import type { UsageSnapshot } from '../../types.js';

/**
 * The power network: what is left to spend, and how hard the floor is pulling.
 *
 * The status bar already drew the 5h window as one bar. What the game gets right
 * and that did not is the *pair* — satisfaction is the instantaneous draw, the
 * accumulator bank is the reserve behind it, and a factory in trouble is one
 * where the second is draining while the first still reads full.
 */

/** Below this much of the window left, the floor visibly dims. Matches the old `.low` threshold. */
const BROWNOUT_AT = 15;

interface PowerReading {
  /** Percentage of the 5h subscriber window still available. Null when never captured. */
  satisfaction: number | null;
  /** Percentage of the 7d window still available. Null when never captured. */
  bank: number | null;
  /** The bank as a segmented gauge: one entry per cell, each 0–1 full. */
  cells: number[];
  /** Reserve is low enough that the whole floor should read as struggling. */
  brownout: boolean;
  fiveHourCostUsd: number;
  sevenDayCostUsd: number;
}

/**
 * A segmented gauge, not a row of individually-charged accumulators.
 *
 * A staircase of differing levels would look more like the game and would be
 * inventing per-cell state that does not exist — there is one number here. So
 * the cells fill left to right from that one number, which is a bank the way a
 * segmented battery is a battery.
 */
export function accumulatorCells(bankPct: number, count: number): number[] {
  const filled = (Math.max(0, Math.min(100, bankPct)) / 100) * count;
  return Array.from({ length: count }, (_, i) => Math.max(0, Math.min(1, filled - i)));
}

export function powerReading(usage: UsageSnapshot, cells = 6): PowerReading {
  const fiveHour = usage.rateLimits?.fiveHour ?? null;
  const sevenDay = usage.rateLimits?.sevenDay ?? null;
  const satisfaction = fiveHour ? Math.max(0, 100 - fiveHour.usedPercentage) : null;
  const bank = sevenDay ? Math.max(0, 100 - sevenDay.usedPercentage) : null;

  return {
    satisfaction,
    bank,
    cells: accumulatorCells(bank ?? 0, cells),
    // Only ever true off a reading we actually have: with no captured limits
    // there is no denominator, and a brownout drawn from nothing would dim the
    // floor for every operator on an API key.
    brownout: satisfaction !== null && satisfaction <= BROWNOUT_AT,
    fiveHourCostUsd: usage.windows.fiveHourCostUsd,
    sevenDayCostUsd: usage.windows.sevenDayCostUsd,
  };
}
