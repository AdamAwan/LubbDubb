import type {
  RemoteReading,
  RemoteRowOutcome,
  RemoteRun,
  RemoteRunStatus,
  StateQuery,
  StateQueryAuthor,
  TenantCall,
  TenantLaunch,
  TenantPreparation,
  WatchReadingVerdict,
} from '../types.js';

export interface StateQueryRow {
  goal_ref: string;
  query_id: string;
  seq: number;
  title: string;
  query: string;
  presence: string;
  why: string | null;
  digest: string;
  authored: string;
  dry_run_environment: string | null;
  dry_run_at: string | null;
  dry_run_verdict: string | null;
  dry_run_presence: string | null;
  dry_run_rows: number | null;
  dry_run_detail: string | null;
  dry_run_sample: string | null;
  created_at: string;
  updated_at: string;
}

export interface SheetRow {
  goal_ref: string;
  environment: string;
  assembled_at: string;
}

export interface SheetRowRow {
  goal_ref: string;
  environment: string;
  row_id: string;
  kind: string;
  seq: number;
  title: string;
  source_id: string;
  selected: number;
  blocked_reason: string | null;
  awaiting_approval: number;
  matched: number | null | undefined;
  idle_reason: string | null | undefined;
  updated_at: string;
}

export interface ReadingRow {
  goal_ref: string;
  environment: string;
  row_id: string;
  run_id: string | null;
  outcome: string;
  rows: number | null;
  value: number | null;
  detail: string | null;
  started_sha: string | null;
  ended_sha: string | null;
  executed: number | null | undefined;
  retries: number | null | undefined;
  duration_ms: number | null | undefined;
  artefacts: string | null | undefined;
  capture: string | null | undefined;
  read_at: string;
}

export function toRemoteReading(r: ReadingRow): RemoteReading {
  return {
    goalRef: r.goal_ref,
    environment: r.environment,
    rowId: r.row_id,
    runId: r.run_id,
    outcome: r.outcome as RemoteRowOutcome,
    rows: r.rows,
    value: r.value,
    detail: r.detail,
    startedSha: r.started_sha ?? null,
    endedSha: r.ended_sha ?? null,
    executed: r.executed ?? null,
    retries: r.retries ?? null,
    durationMs: r.duration_ms ?? null,
    artefacts: r.artefacts ?? null,
    capture: r.capture ?? null,
    readAt: r.read_at,
  };
}

export interface CapturePostRow {
  run_id: string;
  row_id: string;
  goal_ref: string;
  capture: string;
  posted_at: string;
}

export interface RunRow {
  id: string;
  goal_ref: string;
  environment: string;
  tenant: string;
  status: string;
  started_sha: string | null;
  ended_sha: string | null;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  task_id: string | null | undefined;
  report_path: string | null | undefined;
  listing_path: string | null | undefined;
  artefacts: string | null | undefined;
}

export function toTenantPreparation(r: PrepareRow): TenantPreparation {
  return {
    environment: r.environment,
    tenant: r.tenant,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok === null ? null : r.ok === 1,
    detail: r.detail,
    call: tenantCall(r.call),
    launchedAt: r.launched_at ?? null,
  };
}

function tenantCall(value: string | null | undefined): TenantCall | null {
  return value === 'ensure' || value === 'reseed' ? value : null;
}

export function launchOf(r: PrepareRow): { call: TenantCall; launch: TenantLaunch } | null {
  const call = tenantCall(r.call);
  if (call === null || r.launch_id === null || r.launch_id === undefined) return null;
  return { call, launch: { id: r.launch_id, pid: r.pid ?? null, startedAt: r.launched_at ?? r.started_at } };
}

export interface PrepareRow {
  environment: string;
  tenant: string | null;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  detail: string | null;
  call: string | null | undefined;
  launch_id: string | null | undefined;
  pid: number | null | undefined;
  launched_at: string | null | undefined;
}

export interface TenantRow {
  environment: string;
  tenant: string;
  ensured_at: string | null;
  reseeded_at: string | null;
}

const RUN_STATUSES: RemoteRunStatus[] = ['pending', 'dispatched', 'ended', 'abandoned'];

export function toRemoteRun(row: RunRow): RemoteRun {
  return {
    id: row.id,
    goalRef: row.goal_ref,
    environment: row.environment,
    tenant: row.tenant,
    status: RUN_STATUSES.includes(row.status as RemoteRunStatus) ? (row.status as RemoteRunStatus) : 'abandoned',
    startedSha: row.started_sha,
    endedSha: row.ended_sha,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    note: row.note,
    taskId: row.task_id ?? null,
    reportPath: row.report_path ?? null,
    listingPath: row.listing_path ?? null,
    artefacts: row.artefacts ?? null,
  };
}

export interface ApprovalRow {
  query_digest: string;
  environment: string;
  goal_ref: string;
  query_id: string;
  approved_at: string;
  approved_rows: number | null;
  approved_detail: string | null;
}

export function hydrate(row: StateQueryRow): StateQuery {
  return {
    originRef: row.goal_ref,
    id: row.query_id,
    seq: row.seq,
    title: row.title,
    query: row.query,
    presence: row.presence,
    why: row.why,
    digest: row.digest,
    authored: row.authored as StateQueryAuthor,
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict as WatchReadingVerdict | null,
    dryRunPresence: row.dry_run_presence as WatchReadingVerdict | null,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
    dryRunSample: row.dry_run_sample,
  };
}

export function keptDryRun(row: StateQueryRow | null): {
  dryRunEnvironment: string | null;
  dryRunAt: string | null;
  dryRunVerdict: string | null;
  dryRunPresence: string | null;
  dryRunRows: number | null;
  dryRunDetail: string | null;
  dryRunSample: string | null;
} {
  if (row === null)
    return {
      dryRunEnvironment: null,
      dryRunAt: null,
      dryRunVerdict: null,
      dryRunPresence: null,
      dryRunRows: null,
      dryRunDetail: null,
      dryRunSample: null,
    };
  return {
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict,
    dryRunPresence: row.dry_run_presence,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
    dryRunSample: row.dry_run_sample,
  };
}
