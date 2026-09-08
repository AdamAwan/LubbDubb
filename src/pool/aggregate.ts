import { CAUSE_COPY, GUARD_COPY } from '../remedies/remedies.js';
import { PHASE_ORDER, phaseLabel, type SpendPhase } from '../spendInsights.js';
import type { PoolDigestMirrorRow } from '../store/pool.js';
import type { RemedyCause, RemedyGuard, RemedyKind } from '../types.js';
import { throughputMeasureLabel } from '../throughputInsights.js';
import { USAGE_COPY, type UsageEvent } from '../usage/events.js';

// → docs/spec/28-cross-fleet-pool.md

export interface PoolRollupRow {
  key: string;
  label: string;
  count: number;
  costUsd: number | null;
  fleets: number;
  dailyMeanCostUsd: number | null;
}

export interface PoolRollup {
  project: string | null;
  fleets: string[];
  days: string[];
  byPhase: PoolRollupRow[];
  byCause: PoolRollupRow[];
  byCheck: PoolRollupRow[] | null;
  unaccounted: PoolRollupRow;
  unmeasured: PoolRollupRow;
  byUsage: PoolRollupRow[];
  byThroughput: PoolRollupRow[];
}

export function foldPoolDigest(
  rows: readonly PoolDigestMirrorRow[],
  options: { project: string | null; since?: string | null },
): PoolRollup {
  const inWindow = rows.filter((row) => !options.since || row.day >= options.since);
  return {
    project: options.project,
    fleets: [...new Set(inWindow.map((r) => r.fleetId))].sort(),
    days: [...new Set(inWindow.map((r) => r.day))].sort(),
    byPhase: rollup(inWindow, 'phase', poolPhaseLabel).sort(byPhaseOrder),
    byCause: rollup(inWindow, 'cause', poolCauseLabel),
    byCheck: options.project === null ? null : rollup(inWindow, 'check', (key) => key),
    unaccounted: single(inWindow, 'unaccounted', 'Unaccounted returns'),
    unmeasured: single(inWindow, 'unmeasured', 'Unmeasured runs'),
    byUsage: rollup(inWindow, 'usage', poolUsageLabel).sort((a, b) => b.count - a.count),
    byThroughput: rollup(inWindow, 'throughput', throughputMeasureLabel).sort((a, b) => b.count - a.count),
  };
}

function rollup(
  rows: readonly PoolDigestMirrorRow[],
  section: PoolDigestMirrorRow['section'],
  label: (key: string) => string,
): PoolRollupRow[] {
  const byKey = new Map<string, PoolDigestMirrorRow[]>();
  for (const row of rows.filter((r) => r.section === section)) {
    byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  }
  return [...byKey].map(([key, group]) => ({ key, label: label(key), ...totals(group) }));
}

function single(
  rows: readonly PoolDigestMirrorRow[],
  section: PoolDigestMirrorRow['section'],
  label: string,
): PoolRollupRow {
  const group = rows.filter((r) => r.section === section);
  return { key: '', label, ...totals(group) };
}

function totals(rows: readonly PoolDigestMirrorRow[]): Omit<PoolRollupRow, 'key' | 'label'> {
  let count = 0;
  let costUsd: number | null = null;
  for (const row of rows) {
    count += row.count;
    if (row.costUsd !== null) costUsd = (costUsd ?? 0) + row.costUsd;
  }
  const whole = rows.filter((r) => !r.partial && r.costUsd !== null);
  const wholeDays = new Set(whole.map((r) => `${r.fleetId} ${r.day}`)).size;
  return {
    count,
    costUsd: costUsd === null ? null : roundUsd(costUsd),
    fleets: new Set(rows.map((r) => r.fleetId)).size,
    dailyMeanCostUsd:
      wholeDays === 0 ? null : roundUsd(whole.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / wholeDays),
  };
}

function byPhaseOrder(a: PoolRollupRow, b: PoolRollupRow): number {
  return PHASE_ORDER.indexOf(a.key as SpendPhase) - PHASE_ORDER.indexOf(b.key as SpendPhase);
}

export function poolPhaseLabel(key: string): string {
  return PHASE_ORDER.includes(key as SpendPhase) ? phaseLabel(key as SpendPhase) : key;
}

export function poolCauseLabel(key: string): string {
  const [kind, cause, guard] = key.split('/') as [RemedyKind, RemedyCause, RemedyGuard];
  const causeLabel = CAUSE_COPY[cause]?.label ?? cause;
  const guardLabel = GUARD_COPY[guard]?.label ?? guard;
  return `${kind === 'ci' ? 'CI' : 'Review'} · ${causeLabel} · ${guardLabel}`;
}

export function poolUsageLabel(key: string): string {
  return USAGE_COPY[key as UsageEvent]?.label ?? key;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
