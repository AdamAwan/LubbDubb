import { CAUSE_COPY, GUARD_COPY } from '../remedies/remedies.js';
import { PHASE_ORDER, phaseLabel, type SpendPhase } from '../spendInsights.js';
import type { PoolDigestMirrorRow } from '../store/pool.js';
import type { RemedyCause, RemedyGuard, RemedyKind } from '../types.js';
import { USAGE_COPY, type UsageEvent } from '../usage/events.js';

/**
 * The shared insights page's fold: everybody's digest rows, summed across fleets.
 *
 * A **view**, never a database. It reads the pulled documents live — there is no
 * committed artefact and no generated file, so there is nothing for two fleets to
 * conflict on.
 *
 * Two rules run through every function here.
 *
 * **Counts and dollars, never percentages.** A share summed across fleets is
 * meaningless, so shares are taken from summed counts and nothing upstream ships
 * one.
 *
 * **A partial day counts in a total and never in an average.** The origin marks its
 * own current day, and {@link foldPoolDigest} is the one place that reading is
 * acted on — a second reader that forgot it would drag every average down by up to
 * a whole day's width, silently, on the newest number.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-digest-arm`
 */

/** One summed key in one section. */
export interface PoolRollupRow {
  key: string;
  label: string;
  /** Runs, accounts, or dispatches — whichever the section counts. */
  count: number;
  /** Null when every contributing row measured nothing. Never `$0.00` for it. */
  costUsd: number | null;
  /** How many fleets contributed to this row — the reading that says how wide it is. */
  fleets: number;
  /** The mean over **whole** days only, or null when no whole day contributed. */
  dailyMeanCostUsd: number | null;
}

/** The whole cross-fleet reading, for one project or for all of them. */
export interface PoolRollup {
  /** The project this is narrowed to, or null for every project. */
  project: string | null;
  /**
   * The fleets that contributed a digest row inside the window.
   *
   * **This is the denominator of every "how many people" reading on the page.** A
   * fleet is an engineer, so `PoolRollupRow.fleets` against this length is _how many
   * of the people publishing did that thing_ — which is why no per-operator field is
   * needed anywhere below, and why refusing one costs nothing.
   * → `docs/spec/33-usage-metrics.md#the-digest-section`
   */
  fleets: string[];
  /** The UTC days the rows span, oldest first. Empty when nothing has been published. */
  days: string[];
  byPhase: PoolRollupRow[];
  byCause: PoolRollupRow[];
  /**
   * Present **only** when narrowed to one project.
   *
   * Check names cross within a project and never between: three fleets on one
   * problem produce `test (windows)`, `ci/test-windows` and `Build & Test
   * (win-latest)`, and summed across projects that is three rows of one instead of
   * one row of three — a chart saying no single check causes much pain, with
   * nothing red. Two shapes rather than one with a flag, so a reader that forgot the
   * filter cannot sum two unrelated pipelines.
   */
  byCheck: PoolRollupRow[] | null;
  /** Return dispatches that filed no account. Never optional — see the spec. */
  unaccounted: PoolRollupRow;
  /** Runs that reported no usage at all. */
  unmeasured: PoolRollupRow;
  /**
   * What people did, keyed by the usage registry's `subject.verb`.
   *
   * **The event count and the fleet count are both here and are never summed
   * together.** `count` is how many times the thing happened across the pool;
   * `fleets` is how many fleets — how many people — did it at all. One operator
   * amending forty plans and forty operators amending one each are the same `count`
   * and opposite findings, which is the whole reason both ship.
   *
   * No cost: `costUsd` and `dailyMeanCostUsd` are null on every row by construction,
   * because what a person did has no dollar figure anywhere in the harness.
   * → `docs/spec/33-usage-metrics.md#the-digest-section`
   */
  byUsage: PoolRollupRow[];
}

/**
 * Fold the mirror.
 *
 * `since` bounds the window in UTC days, and it is the caller's: the mirror holds
 * ninety days and a reader asks for a week, a month or a quarter out of it, which
 * are all whole numbers of days because the bucket is a day.
 */
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
    // Null and not an empty list: "this reading does not apply across projects" and
    // "no check cost anything" are different facts, and only one of them is drawable.
    byCheck: options.project === null ? null : rollup(inWindow, 'check', (key) => key),
    unaccounted: single(inWindow, 'unaccounted', 'Unaccounted returns'),
    unmeasured: single(inWindow, 'unmeasured', 'Unmeasured runs'),
    // Keyed on two closed vocabularies the harness owns, so it sums across projects
    // like every section but `byCheck` — there is no provider name in either half,
    // and so no project argument to take.
    byUsage: rollup(inWindow, 'usage', poolUsageLabel).sort((a, b) => b.count - a.count),
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

/**
 * Sum one key's rows.
 *
 * `costUsd` stays null while every contributing row was null — a fleet that
 * measured nothing contributes an absence, and folding it to zero would draw it as
 * a fleet that worked for free. The daily mean is over **whole** days only, and is
 * null when the only days in the group were partial.
 */
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

/** The phases in funnel order, so the page reads as the pipeline it partitions. */
function byPhaseOrder(a: PoolRollupRow, b: PoolRollupRow): number {
  return PHASE_ORDER.indexOf(a.key as SpendPhase) - PHASE_ORDER.indexOf(b.key as SpendPhase);
}

/**
 * A phase key in the operator's words. Exported for the same reason
 * {@link poolCauseLabel} is: the markdown companion names these phases too, and two
 * spellings of one vocabulary is how a fleet's page and its file come to disagree.
 */
export function poolPhaseLabel(key: string): string {
  return PHASE_ORDER.includes(key as SpendPhase) ? phaseLabel(key as SpendPhase) : key;
}

/**
 * `ci/gate-missed/undocumented` in the words the local panels already use.
 *
 * The copy comes from `src/remedies/remedies.ts` rather than being restated, which
 * is what makes two fleets' contributions comparable in the operator's language as
 * well as in the data: a key this build has no copy for is drawn as the key, which
 * is what a fleet ahead of you looks like on the glass.
 */
export function poolCauseLabel(key: string): string {
  const [kind, cause, guard] = key.split('/') as [RemedyKind, RemedyCause, RemedyGuard];
  const causeLabel = CAUSE_COPY[cause]?.label ?? cause;
  const guardLabel = GUARD_COPY[guard]?.label ?? guard;
  return `${kind === 'ci' ? 'CI' : 'Review'} · ${causeLabel} · ${guardLabel}`;
}

/**
 * `plan.edit` in the words the local panels already use.
 *
 * The copy comes from `src/usage/events.ts` rather than being restated —
 * {@link poolCauseLabel}'s discipline, one vocabulary over — and the markdown
 * companion names the same keys, which is why this is exported rather than inlined.
 * A key this build has no copy for is drawn as the key, which is what a fleet ahead
 * of you looks like on the glass.
 */
export function poolUsageLabel(key: string): string {
  return USAGE_COPY[key as UsageEvent]?.label ?? key;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
