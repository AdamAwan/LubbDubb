import type { GoalWatch, GoalWatchKind, WatchPlanRecord, WatchReadingVerdict, WatchWindow } from '../../types.js';

// → docs/spec/14-persistence.md

export interface WatchPlanRow {
  goal_ref: string;
  authored_at: string | null;
  note: string | null;
  empty_reason: string | null;
  accepted_at: string | null;
  sent_back_words: string | null;
}

export function hydratePlan(row: WatchPlanRow): WatchPlanRecord {
  return {
    goalRef: row.goal_ref,
    authoredAt: row.authored_at,
    note: row.note,
    emptyReason: row.empty_reason,
    acceptedAt: row.accepted_at,
    sentBackWords: row.sent_back_words,
  };
}

export interface WatchWindowRow {
  goal_ref: string;
  environment: string;
  opened_at: string;
  settles_at: string;
  settled_at: string | null;
  extended_at: string | null;
  exposed_at: string | null;
}

export function hydrateWindow(row: WatchWindowRow): WatchWindow {
  return {
    goalRef: row.goal_ref,
    environment: row.environment,
    openedAt: row.opened_at,
    settlesAt: row.settles_at,
    settledAt: row.settled_at,
    extendedAt: row.extended_at,
    exposedAt: row.exposed_at,
  };
}

export interface WatchReadingRow {
  goal_ref: string;
  environment: string;
  check_id: string;
  read_at: string;
  verdict: string;
  rows_read: number | null;
  value: number | null;
  detail: string | null;
  read_by: string | null;
}

export interface WatchAskRow {
  task_id: string;
  goal_ref: string;
  check_id: string;
  environment: string;
  ask: string;
  since: string;
  until: string;
}

export interface GoalWatchRow {
  goal_ref: string;
  created_at: string;
  check_id: string;
  seq: number;
  kind: string;
  title: string;
  query: string;
  presence: string | null;
  tolerate: number;
  expect_under: number | null;
  expect_over: number | null;
  expect_baseline: number;
  unit: string | null;
  baseline_value: number | null;
  baseline_at: string | null;
  live: number;
  authored: string;
  why: string | null;
  source: string | null;
  changed_from_hint: string | null;
  dry_run_environment: string | null;
  dry_run_at: string | null;
  dry_run_verdict: string | null;
  dry_run_presence: string | null;
  dry_run_rows: number | null;
  dry_run_detail: string | null;
}

export function keptAnswers(row: GoalWatchRow | null) {
  if (row === null)
    return {
      baselineValue: null,
      baselineAt: null,
      dryRunEnvironment: null,
      dryRunAt: null,
      dryRunVerdict: null,
      dryRunPresence: null,
      dryRunRows: null,
      dryRunDetail: null,
    };
  return {
    baselineValue: row.baseline_value,
    baselineAt: row.baseline_at,
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict,
    dryRunPresence: row.dry_run_presence,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
  };
}

export function hydrate(row: GoalWatchRow): GoalWatch {
  return {
    originRef: row.goal_ref,
    id: row.check_id,
    seq: row.seq,
    kind: row.kind as GoalWatchKind,
    title: row.title,
    query: row.query,
    presence: row.presence,
    tolerate: row.tolerate,
    expectUnder: row.expect_under,
    expectOver: row.expect_over,
    expectBaseline: row.expect_baseline === 1,
    unit: row.unit,
    why: row.why,
    source: row.source,
    baselineValue: row.baseline_value,
    baselineAt: row.baseline_at,
    live: row.live === 1,
    authored: row.authored === 'operator' || row.authored === 'assessor' ? row.authored : 'plan',
    changedFromHint: row.changed_from_hint ?? null,
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict as WatchReadingVerdict | null,
    dryRunPresence: row.dry_run_presence as WatchReadingVerdict | null,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
  };
}
