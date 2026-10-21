import type { AppErrorGroup, AppErrorSpike, AppErrorState } from '../types.js';
import { DAY_MS, utcDay } from '../primitives.js';
import { QUIET_MS, dayStart } from './groups.js';

// → docs/spec/39-app-errors.md#states

/** With no deploy on record, a group first seen this recently reads `new`. */
const NEW_FALLBACK_MS = DAY_MS;

/** Days before the deploy whose counts make a group's baseline. */
export const BASELINE_DAYS = 7;

/** How many times its baseline daily rate a group must run at to read `spiking`. */
const SPIKE_RATIO = 3;

/** The baseline is never taken as lower than this many a day, so one-a-week does not spike at three. */
const SPIKE_FLOOR_PER_DAY = 1;

export interface AppErrorStateInput {
  group: Pick<AppErrorGroup, 'firstSeen' | 'lastSeen' | 'returnedAt' | 'daily'>;
  deployedAt: string | null;
  now: number;
  minCount: number;
  ignored: boolean;
}

export function appErrorCount(group: Pick<AppErrorGroup, 'daily'>): number {
  return group.daily.reduce((sum, d) => sum + d.count, 0);
}

export function appErrorState(input: AppErrorStateInput): AppErrorState {
  return appErrorReading(input).state;
}

/** The state, and the two rates a `spiking` state was read off — null in every other state. */
export function appErrorReading(input: AppErrorStateInput): { state: AppErrorState; spike: AppErrorSpike | null } {
  const rates = spikeRates(input);
  const state = stateOf(input, rates);
  return {
    state,
    spike:
      state === 'spiking' && rates !== null ? { perDay: rates.perDay, baselinePerDay: rates.baselinePerDay } : null,
  };
}

function stateOf(input: AppErrorStateInput, rates: SpikeRates | null): AppErrorState {
  const { group, deployedAt, now } = input;
  if (Date.parse(group.lastSeen) < now - QUIET_MS) return 'gone';
  const muted = input.ignored || appErrorCount(group) < input.minCount;
  if (muted) return 'steady';
  const firstSeen = Date.parse(group.firstSeen);
  if (deployedAt !== null ? firstSeen >= Date.parse(deployedAt) : firstSeen >= now - NEW_FALLBACK_MS) return 'new';
  if (group.returnedAt !== null && Date.parse(group.returnedAt) >= now - QUIET_MS) return 'returned';
  if (rates !== null && rates.current >= input.minCount && rates.perDay >= SPIKE_RATIO * rates.baselinePerDay)
    return 'spiking';
  return 'steady';
}

type SpikeRates = AppErrorSpike & { current: number };

function spikeRates({ group, deployedAt, now }: AppErrorStateInput): SpikeRates | null {
  const windowDay = utcDay(deployedAt !== null ? Date.parse(deployedAt) : now - DAY_MS);
  const windowStart = dayStart(windowDay);
  const baselineFrom = Math.max(windowStart - BASELINE_DAYS * DAY_MS, dayStart(utcDay(Date.parse(group.firstSeen))));
  const baselineDays = Math.round((windowStart - baselineFrom) / DAY_MS);
  if (baselineDays <= 0) return null;
  let current = 0;
  let before = 0;
  for (const { day, count } of group.daily) {
    const at = dayStart(day);
    if (at >= windowStart) current += count;
    else if (at >= baselineFrom) before += count;
  }
  return {
    current,
    perDay: current / Math.max(1, (now - windowStart) / DAY_MS),
    baselinePerDay: Math.max(before / baselineDays, SPIKE_FLOOR_PER_DAY),
  };
}
