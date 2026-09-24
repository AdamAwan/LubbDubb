import type { SpendPhase, SpendTrend } from '../types.js';

// → docs/spec/17-cockpit.md

export const PHASE_ORDER: readonly SpendPhase[] = [
  'deliberation',
  'build',
  'ci',
  'landing',
  'evidence',
  'obstacle',
  'job',
  'other',
];

export const PLOT = { left: 44, right: 600, top: 12, bottom: 128 };
export const VIEW_BOX = '0 0 646 150';

export function periodWord(trend: SpendTrend): string {
  const hours = trend.bucketMs / 3_600_000;
  if (hours <= 12) return `${Math.round(hours)}h period`;
  if (hours <= 36) return 'day';
  if (hours <= 24 * 10) return 'week';
  if (hours <= 24 * 45) return 'month';
  return 'quarter';
}

export function fmtPct(fraction: number): string {
  const pct = fraction * 100;
  if (pct === 0) return '0%';
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

export function fmtChange(ratio: number | null): string {
  if (ratio === null) return 'new';
  const pct = Math.round(ratio * 100);
  if (pct === 0) return 'level';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

export function toneOf(ratio: number | null, fallingIsGood: boolean): string {
  if (ratio === null || Math.round(ratio * 100) === 0) return 'level';
  return ratio < 0 === fallingIsGood ? 'good' : 'bad';
}

export function fmtPts(now: number | null, then: number | null): { text: string; delta: number | null } {
  if (now === null || then === null) return { text: 'no comparison', delta: null };
  const delta = Math.round(now * 100) - Math.round(then * 100);
  if (delta === 0) return { text: 'level', delta: 0 };
  return { text: `${delta > 0 ? '+' : '−'}${Math.abs(delta)} pts`, delta };
}

export function ptsTone(delta: number | null, fallingIsGood: boolean): string {
  if (delta === null || delta === 0) return 'level';
  return delta < 0 === fallingIsGood ? 'good' : 'bad';
}

export function columns(count: number): { width: number; centre: (i: number) => number } {
  const width = (PLOT.right - PLOT.left) / count;
  return { width, centre: (i: number) => PLOT.left + i * width + width / 2 };
}
