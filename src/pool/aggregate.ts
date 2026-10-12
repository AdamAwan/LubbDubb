import { CAUSE_COPY, GUARD_COPY } from '../remedies/remedies.js';
import { PHASE_ORDER, phaseLabel, type SpendPhase } from '../insights/spendInsights.js';
import type { PoolDigestMirrorRow } from '../store/pool.js';
import type { RemedyCause, RemedyGuard, RemedyKind } from '../types.js';
import { throughputMeasureLabel } from '../insights/throughputInsights.js';
import { choiceLabel } from '../insights/choiceInsights.js';
import type { UsageEvent } from '../usage/events.js';
import { USAGE_COPY } from '../usage/eventCopy.js';
import { ruleName } from '../insights/taskTypeSpend.js';
import { quantile } from '../primitives.js';

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
  byChoice: PoolRollupRow[];
}

export function foldPoolDigest(
  rows: readonly PoolDigestMirrorRow[],
  options: { project: string | null; since?: string | null },
): PoolRollup {
  const inWindow = rows.filter((row) => !options.since || row.day >= options.since);
  const measured = inWindow.filter((row) => row.section !== 'version');
  return {
    project: options.project,
    fleets: [...new Set(measured.map((r) => r.fleetId))].sort(),
    days: [...new Set(measured.map((r) => r.day))].sort(),
    byPhase: rollup(inWindow, 'phase', poolPhaseLabel).sort(byPhaseOrder),
    byCause: rollup(inWindow, 'cause', poolCauseLabel),
    byCheck: options.project === null ? null : rollup(inWindow, 'check', (key) => key),
    unaccounted: single(inWindow, 'unaccounted', 'Unaccounted returns'),
    unmeasured: single(inWindow, 'unmeasured', 'Unmeasured runs'),
    byUsage: rollup(inWindow, 'usage', poolUsageLabel).sort((a, b) => b.count - a.count),
    byThroughput: rollup(inWindow, 'throughput', throughputMeasureLabel).sort((a, b) => b.count - a.count),
    byChoice: rollup(inWindow, 'choice', choiceLabel).sort((a, b) => a.key.localeCompare(b.key)),
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

const TREND_SMOOTHING_DAYS = 7;

const TREND_COMPARE_DAYS = 14;

const TREND_RECENT_DAYS = 30;

const TREND_STEADY_PCT = 5;

type TrendVerdict = 'cheaper' | 'dearer' | 'steady';

interface TrendShift {
  beforePerRunUsd: number | null;
  afterPerRunUsd: number | null;
  changePct: number | null;
  verdict: TrendVerdict | null;
}

interface PoolTrendStep {
  key: string;
  label: string;
  runs: number;
  fleets: number;
  recent: TrendShift;
  median: (number | null)[];
  lower: (number | null)[];
  upper: (number | null)[];
  byFleet: { fleetId: string; perRunUsd: (number | null)[] }[];
  releases: PoolTrendRelease[];
}

interface PoolTrendRelease extends TrendShift {
  version: string;
  day: string;
  cheaper: number;
  dearer: number;
  steady: number;
  fleets: (TrendShift & { fleetId: string; day: string })[];
}

export interface PoolTrends {
  windows: { smoothingDays: number; compareDays: number; recentDays: number };
  days: string[];
  steps: PoolTrendStep[];
}

interface Cell {
  cost: number;
  runs: number;
}

export function foldPoolTrends(rows: readonly PoolDigestMirrorRow[]): PoolTrends {
  const whole = rows.filter((r) => !r.partial);
  const days = dayRange(whole.filter((r) => r.section === 'rule' || r.section === 'version').map((r) => r.day));
  const adoptions = adoptionDays(whole.filter((r) => r.section === 'version'));

  const cells = new Map<string, Map<string, Map<string, Cell>>>();
  for (const row of whole) {
    if (row.section !== 'rule' || row.costUsd === null) continue;
    const byFleet = cells.get(row.key) ?? new Map<string, Map<string, Cell>>();
    const byDay = byFleet.get(row.fleetId) ?? new Map<string, Cell>();
    byDay.set(row.day, addCell(byDay.get(row.day), { cost: row.costUsd, runs: row.count }));
    byFleet.set(row.fleetId, byDay);
    cells.set(row.key, byFleet);
  }

  const steps = [...cells].map(([key, byFleet]) => trendStep(key, byFleet, days, adoptions));
  return {
    windows: { smoothingDays: TREND_SMOOTHING_DAYS, compareDays: TREND_COMPARE_DAYS, recentDays: TREND_RECENT_DAYS },
    days,
    steps: steps.sort((a, b) => b.runs - a.runs || a.label.localeCompare(b.label)),
  };
}

function trendStep(
  key: string,
  byFleet: ReadonlyMap<string, ReadonlyMap<string, Cell>>,
  days: readonly string[],
  adoptions: ReadonlyMap<string, ReadonlyMap<string, string>>,
): PoolTrendStep {
  const byFleetSeries = [...byFleet.keys()].sort().map((fleetId) => ({
    fleetId,
    perRunUsd: days.map((_, i) =>
      perRunOf(sumOver(byFleet.get(fleetId)!, days.slice(Math.max(0, i - TREND_SMOOTHING_DAYS + 1), i + 1))),
    ),
  }));
  const spread = days.map((_, i) =>
    byFleetSeries.flatMap((s) => (s.perRunUsd[i] == null ? [] : [s.perRunUsd[i]!])).sort((a, b) => a - b),
  );
  let runs = 0;
  for (const byDay of byFleet.values()) for (const cell of byDay.values()) runs += cell.runs;
  const releases = [...adoptions]
    .map(([version, adoptedOn]) => trendRelease(version, byFleet, adoptedOn, days.at(-1) ?? ''))
    .filter((r): r is PoolTrendRelease => r !== null)
    .sort((a, b) => a.day.localeCompare(b.day) || a.version.localeCompare(b.version));
  return {
    key,
    label: ruleName(key),
    runs,
    fleets: byFleetSeries.length,
    recent: shift(
      pooled(byFleet, days.slice(-2 * TREND_RECENT_DAYS, -TREND_RECENT_DAYS)),
      pooled(byFleet, days.slice(-TREND_RECENT_DAYS)),
    ),
    median: spread.map((sorted) => sortedQuantile(sorted, 0.5)),
    lower: spread.map((sorted) => sortedQuantile(sorted, 0.25)),
    upper: spread.map((sorted) => sortedQuantile(sorted, 0.75)),
    byFleet: byFleetSeries,
    releases,
  };
}

function trendRelease(
  version: string,
  byFleet: ReadonlyMap<string, ReadonlyMap<string, Cell>>,
  adoptedOn: ReadonlyMap<string, string>,
  lastDay: string,
): PoolTrendRelease | null {
  const fleets: PoolTrendRelease['fleets'] = [];
  let before: Cell = { cost: 0, runs: 0 };
  let after: Cell = { cost: 0, runs: 0 };
  for (const [fleetId, day] of adoptedOn) {
    const byDay = byFleet.get(fleetId);
    if (byDay === undefined) continue;
    const afterDays = shiftDays(day, 1, TREND_COMPARE_DAYS);
    const b = sumOver(byDay, shiftDays(day, -TREND_COMPARE_DAYS, TREND_COMPARE_DAYS));
    const a = afterDays.at(-1)! <= lastDay ? sumOver(byDay, afterDays) : { cost: 0, runs: 0 };
    if (b.runs === 0 && sumOver(byDay, [day, ...afterDays]).runs === 0) continue;
    fleets.push({ fleetId, day, ...shift(b, a) });
    if (b.runs === 0 || a.runs === 0) continue;
    before = addCell(before, b);
    after = addCell(after, a);
  }
  if (fleets.length === 0) return null;
  const count = (verdict: TrendVerdict) => fleets.filter((f) => f.verdict === verdict).length;
  return {
    version,
    day: fleets.map((f) => f.day).sort()[0]!,
    ...shift(before, after),
    cheaper: count('cheaper'),
    dearer: count('dearer'),
    steady: count('steady'),
    fleets: fleets.sort((x, y) => x.fleetId.localeCompare(y.fleetId)),
  };
}

function shift(before: Cell, after: Cell): TrendShift {
  const beforePerRunUsd = perRunOf(before);
  const afterPerRunUsd = perRunOf(after);
  const changePct =
    beforePerRunUsd === null || afterPerRunUsd === null || beforePerRunUsd === 0
      ? null
      : Math.round(((afterPerRunUsd - beforePerRunUsd) / beforePerRunUsd) * 100);
  const verdict =
    changePct === null
      ? null
      : changePct <= -TREND_STEADY_PCT
        ? 'cheaper'
        : changePct >= TREND_STEADY_PCT
          ? 'dearer'
          : 'steady';
  return { beforePerRunUsd, afterPerRunUsd, changePct, verdict };
}

function adoptionDays(rows: readonly PoolDigestMirrorRow[]): Map<string, Map<string, string>> {
  const firstSeen = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const byVersion = firstSeen.get(row.fleetId) ?? new Map<string, string>();
    const seen = byVersion.get(row.key);
    if (seen === undefined || row.day < seen) byVersion.set(row.key, row.day);
    firstSeen.set(row.fleetId, byVersion);
  }
  const adoptions = new Map<string, Map<string, string>>();
  for (const [fleetId, byVersion] of firstSeen) {
    const start = [...byVersion.values()].sort()[0];
    for (const [version, day] of byVersion) {
      if (day === start) continue;
      const byFleet = adoptions.get(version) ?? new Map<string, string>();
      byFleet.set(fleetId, day);
      adoptions.set(version, byFleet);
    }
  }
  return adoptions;
}

function pooled(byFleet: ReadonlyMap<string, ReadonlyMap<string, Cell>>, days: readonly string[]): Cell {
  let total: Cell = { cost: 0, runs: 0 };
  for (const byDay of byFleet.values()) total = addCell(total, sumOver(byDay, days));
  return total;
}

function sumOver(byDay: ReadonlyMap<string, Cell>, days: readonly string[]): Cell {
  let total: Cell = { cost: 0, runs: 0 };
  for (const day of days) total = addCell(total, byDay.get(day));
  return total;
}

function addCell(into: Cell | undefined, from: Cell | undefined): Cell {
  return { cost: (into?.cost ?? 0) + (from?.cost ?? 0), runs: (into?.runs ?? 0) + (from?.runs ?? 0) };
}

function perRunOf(cell: Cell): number | null {
  return cell.runs === 0 ? null : roundUsd(cell.cost / cell.runs);
}

function sortedQuantile(sorted: readonly number[], q: number): number | null {
  const value = quantile(sorted, q);
  return value === null ? null : roundUsd(value);
}

function dayRange(days: readonly string[]): string[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort();
  return shiftDays(sorted[0]!, 0, (Date.parse(sorted.at(-1)!) - Date.parse(sorted[0]!)) / 86_400_000 + 1);
}

function shiftDays(from: string, offset: number, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000;
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}
