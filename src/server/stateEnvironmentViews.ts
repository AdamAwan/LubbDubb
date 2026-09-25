import type { System } from '../system.js';
import { sheetFoldLine } from '../remoteValidation/sheet.js';
import { resolveTenant } from '../remoteValidation/tenants.js';
import type {
  EnvironmentHealthReading,
  GoalArrival,
  GoalWatch,
  IssueDelivery,
  IssueShortfall,
  Plan,
  PlanPart,
  TaskSummary,
  WatchReading,
  WorkNode,
} from '../types.js';
import type {
  GoalReachView,
  GoalWatchView,
  RemoteReadingView,
  RemoteSheetView,
  TenantCommandView,
  TenantPreparation,
} from '../wire.js';
import { allGoalReach } from '../environments/reach.js';
import { environmentGateHold } from '../environments/arrival.js';
import type { EnvironmentConfig } from '../environments/policy.js';

// → docs/spec/16-http-api.md

export function buildEnvironmentHealth(
  store: System['store'],
  environments: EnvironmentConfig[],
): EnvironmentHealthReading[] {
  const byEnvironment = groupBy(store.environments.listEnvironmentHealth(), (r) => r.environment);
  return environments.filter((env) => env.health !== undefined).flatMap((env) => byEnvironment.get(env.name) ?? []);
}

export function buildEnvironmentReach(input: {
  store: System['store'];
  environments: EnvironmentConfig[];
  sheets: readonly RemoteSheetView[];
  plans: Plan[];
  parts: PlanPart[];
  arrivals: GoalArrival[];
  nodes: WorkNode[];
  delivered: readonly IssueDelivery[];
  shortfalled: ReadonlyMap<string, IssueShortfall>;
}): GoalReachView[] {
  const { store, environments, sheets, plans, parts, arrivals, nodes } = input;
  const releases = store.environments.listEnvironmentGateReleases();
  const released = new Map(releases.map((r) => [r.goalRef, r]));
  const holds = new Map<string, string>();
  const gated = new Set<string>();
  for (const { originRef: goalRef } of input.delivered) {
    if (input.shortfalled.has(goalRef)) continue;
    const hold = environmentGateHold({ goalRef, environments, arrivals, releases });
    if (hold !== null) holds.set(goalRef, hold);
    if (hold !== null || released.has(goalRef)) gated.add(goalRef);
  }
  const sheetByGoalEnvironment = new Map<string, RemoteSheetView>();
  for (const sheet of sheets) {
    const key = `${sheet.goalRef} ${sheet.environment}`;
    if (!sheetByGoalEnvironment.has(key)) sheetByGoalEnvironment.set(key, sheet);
  }
  return allGoalReach({
    held: gated,
    landings: store.environments.listGoalLandings(),
    readings: store.environments.listEnvironmentReach(),
    nodes,
    landed: store.environments.landedPrs(),
    plans,
    parts,
    environments,
  }).map((goal) => ({
    ...goal,
    // Folded here rather than in the cockpit, off the same rows the sheet card draws.
    // → 36-remote-validation.md#the-cockpit
    environments: goal.environments.map((env) => ({
      ...env,
      sheet: sheetFold(sheetByGoalEnvironment.get(`${goal.goalRef} ${env.environment}`)),
    })),
    gateHold: holds.get(goal.goalRef) ?? null,
    released: released.get(goal.goalRef) ?? null,
  }));
}

function sheetFold(sheet: RemoteSheetView | undefined): string | null {
  if (sheet === undefined) return null;
  return sheetFoldLine(
    sheet.rows.map((row) => ({ blockedReason: row.blockedReason, outcome: row.reading?.outcome ?? null })),
  );
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const held = grouped.get(key(row));
    if (held) held.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

export function buildGoalWatchWindows(
  store: System['store'],
  environments: EnvironmentConfig[],
  readGoalWatches: () => GoalWatch[],
): GoalWatchView[] {
  if (!environments.some((e) => e.watch !== undefined)) return [];
  const windows = store.watches.listWatchWindows();
  if (windows.length === 0) return [];
  const newest = new Map<string, WatchReading>();
  for (const r of store.watches.listWatchReadings()) newest.set(`${r.goalRef} ${r.environment} ${r.checkId}`, r);
  const checksByGoal = groupBy(readGoalWatches(), (c) => c.originRef);
  return windows.map((window) => ({
    ...window,
    checks: (checksByGoal.get(window.goalRef) ?? []).map((c) => ({
      checkId: c.id,
      title: c.title,
      kind: c.kind,
      tolerate: c.tolerate,
      expectUnder: c.expectUnder,
      expectOver: c.expectOver,
      expectBaseline: c.expectBaseline,
      unit: c.unit,
      baselineValue: c.baselineValue,
      reading: newest.get(`${window.goalRef} ${window.environment} ${c.id}`) ?? null,
    })),
  }));
}

/**
 * The sheets an arrival assembled, with the latest reading on every row folded in here rather than
 * in the cockpit — a cockpit that worked an outcome out for itself would be a second opinion drawn
 * beside the reading it describes. Absent entirely where no environment declares a `validate` block:
 * a card of question marks on a deployment that configured nothing reads as broken.
 */
export function buildRemoteSheets(
  store: System['store'],
  environments: EnvironmentConfig[],
  tasks: readonly TaskSummary[],
  captureSigner?: (runId: string, rowId: string) => string,
): RemoteSheetView[] {
  if (!environments.some((e) => e.validate !== undefined)) return [];
  const sheets = store.remoteValidation.listRemoteSheets();
  if (sheets.length === 0) return [];
  const runs = store.remoteValidation.listRemoteRuns();
  // The way from a reading to the transcript of the agent that produced it, walked here: a reading
  // carries the run it came through, a run carries the task it was dispatched as, and a task carries
  // the agent. The tasks are the caller's own list rather than a lookup per reading — one statement a
  // snapshot already ran. → docs/spec/36-remote-validation.md#the-reading-an-agent-produced
  const taskOfRun = new Map(runs.map((run) => [run.id, run.taskId]));
  const agentOfTask = new Map(tasks.map((task) => [task.id, task.agentId]));
  const newest = new Map<string, RemoteReadingView>();
  for (const r of store.remoteValidation.listRemoteReadings()) {
    const taskId = r.runId === null ? null : (taskOfRun.get(r.runId) ?? null);
    newest.set(`${r.goalRef} ${r.environment} ${r.rowId}`, {
      ...r,
      taskId,
      agentId: taskId === null ? null : (agentOfTask.get(taskId) ?? null),
      captureUrl: remoteCaptureUrl(r, captureSigner),
    });
  }
  const rowsByGoalEnvironment = groupBy(
    store.remoteValidation.listRemoteSheetRows(),
    (row) => `${row.goalRef} ${row.environment}`,
  );
  const runsByGoalEnvironment = groupBy(runs, (run) => `${run.goalRef} ${run.environment}`);
  const tenants = store.remoteValidation.listRemoteTenants();
  const prepares = new Map(store.remoteValidation.listTenantPrepares().map((p) => [p.environment, p]));
  const now = Date.now();
  return sheets.map((sheet) => {
    const key = `${sheet.goalRef} ${sheet.environment}`;
    const environment = environments.find((e) => e.name === sheet.environment);
    const validate = environment?.validate;
    // The `tenantEnv` value is never folded in: the standing carries the *variable's* name, and the
    // value it holds reaches the spawn env and nowhere else. → 36-remote-validation.md#tenants
    const standing =
      environment === undefined
        ? { tenant: null, reseededAt: null, ageMs: null, freshnessMs: null, stale: false, blockedReason: null }
        : resolveTenant({ environment, stamped: tenants, now }).standing;
    return {
      ...sheet,
      rows: (rowsByGoalEnvironment.get(key) ?? []).map((row) => ({
        ...row,
        reading: newest.get(`${row.goalRef} ${row.environment} ${row.rowId}`) ?? null,
      })),
      run: runsByGoalEnvironment.get(key)?.at(-1) ?? null,
      tenant: {
        ...standing,
        reseedable: validate?.reseed !== undefined || validate?.ensureTenant !== undefined,
        destructive: validate?.reseed !== undefined,
        preparation: prepares.get(sheet.environment) ?? null,
      },
    };
  });
}

export function tenantCommandViews(
  environments: readonly EnvironmentConfig[],
  prepares: readonly TenantPreparation[],
): TenantCommandView[] {
  return environments.flatMap((env) => {
    const validate = env.validate;
    if (validate?.ensureTenant === undefined && validate?.reseed === undefined) return [];
    return [
      {
        environment: env.name,
        ensureTenant: validate.ensureTenant ?? null,
        reseed: validate.reseed ?? null,
        preparation: prepares.find((p) => p.environment === env.name) ?? null,
      },
    ];
  });
}

/**
 * Where a **sheet row's** capture can be looked at, keyed on the run and the row rather than on the
 * check. A run that declined to overwrite a check somebody else settled keeps its reading — and the
 * screen it took — here, and until this existed that screen was reachable only on disk.
 * → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at
 */
function remoteCaptureUrl(
  reading: { runId: string | null; rowId: string; capture: string | null },
  signer?: (runId: string, rowId: string) => string,
): string | null {
  if (reading.capture === null || reading.runId === null) return null;
  const base = `/validation-captures/run/${encodeURIComponent(reading.runId)}/${encodeURIComponent(reading.rowId)}`;
  return signer ? `${base}?tk=${encodeURIComponent(signer(reading.runId, reading.rowId))}` : base;
}
