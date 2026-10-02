import type { System } from '../system/system.js';
import { groupBy } from '../primitives.js';
import { noSheetReason, sheetFoldLine } from '../validation/remote/sheet.js';
import type { CheckSetStanding } from '../validation/planApproval.js';
import { goneCheckRows, okable, okStanding, pageRows } from '../validation/remote/intent.js';
import { resolveTenant, type OperatorTenants } from '../validation/remote/tenants.js';
import type {
  EnvironmentHealthReading,
  GoalArrival,
  GoalReachStatus,
  NoSheet,
  GoalWatch,
  IssueDelivery,
  IssueShortfall,
  Plan,
  PlanPart,
  ValidationCheck,
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
import { arrivalSheetStep } from '../environments/watchWindow.js';
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
  probeIntervalMs: number;
  now: number;
  checkSet: (goalRef: string) => CheckSetStanding;
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
  const noSheet = noSheetFold(input);
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
    environments: goal.environments.map((env) => {
      const sheet = sheetByGoalEnvironment.get(`${goal.goalRef} ${env.environment}`);
      return { ...env, sheet: sheetFold(sheet), noSheet: sheet === undefined ? noSheet(goal.goalRef, env) : null };
    }),
    gateHold: holds.get(goal.goalRef) ?? null,
    released: released.get(goal.goalRef) ?? null,
  }));
}

/** Why a validating environment holds no sheet for a goal, read off the desk's own cut. */
function noSheetFold(input: {
  checkSet: (goalRef: string) => CheckSetStanding;
  environments: EnvironmentConfig[];
  arrivals: GoalArrival[];
  probeIntervalMs: number;
  now: number;
}): (goalRef: string, env: { environment: string; status: GoalReachStatus }) => NoSheet | null {
  const validating = new Set(input.environments.filter((e) => e.validate !== undefined).map((e) => e.name));
  const arrivals = new Map<string, GoalArrival>();
  for (const arrival of input.arrivals) {
    const key = `${arrival.goalRef} ${arrival.environment}`;
    if (!arrivals.has(key)) arrivals.set(key, arrival);
  }
  return (goalRef, env) => {
    if (!validating.has(env.environment)) return null;
    const arrival = arrivals.get(`${goalRef} ${env.environment}`);
    const step =
      arrival === undefined
        ? null
        : arrivalSheetStep({
            arrival,
            validates: true,
            checkSet: () => input.checkSet(goalRef),
            probeIntervalMs: input.probeIntervalMs,
            now: input.now,
          });
    return noSheetReason({ environment: env.environment, status: env.status, step });
  };
}

function sheetFold(sheet: RemoteSheetView | undefined): string | null {
  if (sheet === undefined) return null;
  return sheetFoldLine(
    sheet.rows.map((row) => ({ blockedReason: row.blockedReason, outcome: row.reading?.outcome ?? null })),
  );
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
  operatorTenants?: OperatorTenants,
  checks: readonly ValidationCheck[] = [],
): RemoteSheetView[] {
  if (!environments.some((e) => e.validate !== undefined)) return [];
  const sheets = store.remoteValidation.listRemoteSheets();
  if (sheets.length === 0) return [];
  const runs = store.remoteValidation.listRemoteRuns();
  const intents = new Map(store.remoteIntents.listIntents().map((i) => [`${i.goalRef} ${i.environment}`, i]));
  const gone = goneCheckRows(checks);
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
        : resolveTenant({ environment, stamped: tenants, now, operatorTenants }).standing;
    const rows = pageRows(rowsByGoalEnvironment.get(key) ?? [], gone);
    const intent = intents.get(key) ?? null;
    const run = runsByGoalEnvironment.get(key)?.at(-1) ?? null;
    return {
      ...sheet,
      rows: rows.map((row) => ({
        ...row,
        reading: newest.get(`${row.goalRef} ${row.environment} ${row.rowId}`) ?? null,
      })),
      run,
      intent,
      // An environment that no longer validates asks for nothing, as the `validate` row's hold reads it.
      okable: validate === undefined ? 0 : rows.filter(okable).length,
      ok: validate === undefined ? { status: 'nothing', why: null } : okStanding({ rows, intent, run }),
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
