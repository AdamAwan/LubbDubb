import type { Agent, PrReview, PrReviewRoute, TaskSummary, WorldSnapshot } from './types.js';
import type { Store } from './store/store.js';
import type { ErrorRecorder } from './errorLog.js';
import type { LimitResumeFailure } from './agents/agentManager.js';
import type { AppraisalDesk } from './intake/appraisalDesk.js';
import type { AreaPathDirectory } from './intake/areaPaths.js';
import type { SpendBurnDesk } from './spendBurnDesk.js';
import type { PrReviewPolicy } from './review/policy.js';
import { askReviewedElsewhere, type ReviewProber } from './review/reviewedElsewhere.js';
import { awaitingReview } from './pr/prHealth.js';
import { isActiveTask } from './tasks.js';
import { runsToRecord, type CompletionSignals } from './floor/runs.js';
import type { PlanReconciler } from './plans/planReconciler.js';
import type { PrNamingDesk } from './pr/prNamingDesk.js';
import type { PrWatchDesk } from './pr/prWatchDesk.js';
import type { PrWorkItemDesk } from './pr/prWorkItemDesk.js';
import type { BranchReapDesk } from './branchReapDesk.js';
import type { StackLandingDesk } from './stacks/landingDesk.js';
import type { ValidationAskDesk } from './validation/askDesk.js';
import type { ValidationReadyDesk } from './validation/readyDesk.js';
import type { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import type { ScheduleDesk } from './schedules/scheduleDesk.js';
import type { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import type { EnvironmentDesk } from './environments/environmentDesk.js';
import type { RemoteValidationDesk } from './remoteValidation/desk.js';
import type { ObstacleDesk } from './obstacles/desk.js';
import type { PoolDesk } from './pool/poolDesk.js';

// → docs/spec/04-harness-cycle.md

export interface PulseDeps {
  store: Store;
  errors: ErrorRecorder;
  review: PrReviewPolicy;
  reviewProber?: ReviewProber;
  plans?: PlanReconciler;
  prWatch?: PrWatchDesk;
  prWorkItems?: PrWorkItemDesk;
  naming?: PrNamingDesk;
  branchReaps?: BranchReapDesk;
  landings?: StackLandingDesk;
  validationAsks?: ValidationAskDesk;
  schedules?: ScheduleDesk;
  updates?: { run(): Promise<void> };
  graph?: WorkGraphRecorder;
  environments?: EnvironmentDesk;
  remoteValidation?: RemoteValidationDesk;
  validationReady?: ValidationReadyDesk;
  closeOuts?: DeliveryCloseOutDesk;
  notices?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  graduations?: { run(): void };
  clusters?: { run(): void };
  obstacles?: ObstacleDesk;
  pool?: PoolDesk;
  fleet?: { resumeExpiredParks(): LimitResumeFailure[]; completeExpiredStalls(): string[] };
  ejections?: { sweepExpiries(): unknown[] };
  burn?: SpendBurnDesk;
  escalations?: { tidyDeadAgents(): unknown[]; tidySettledMerges(): unknown[] };
  appraisals?: AppraisalDesk;
  areaPaths?: AreaPathDirectory;
  localValidations?: { sweep(): void };
  tickets?: { run(): Promise<void> };
}

type PulsePhase =
  | 'reconcile'
  | 'open'
  | 'afterTasks'
  | 'afterAgents'
  | 'afterVerdicts'
  | 'afterOrigins'
  | 'afterReviews'
  | 'afterExecute';

interface PulseReadings {
  reconcile: { world: WorldSnapshot; previousWorld: WorldSnapshot | null; readWorld: boolean };
  open: Record<string, never>;
  afterTasks: { world: WorldSnapshot; tasks: TaskSummary[] };
  afterAgents: { tasks: TaskSummary[]; agents: Agent[] };
  afterVerdicts: { world: WorldSnapshot };
  afterOrigins: { world: WorldSnapshot; tasks: TaskSummary[]; signals: CompletionSignals };
  afterReviews: { dispatchWorld: WorldSnapshot; prReviews: PrReview[]; prReviewRoutes: PrReviewRoute[] };
  afterExecute: Record<string, never>;
}

interface PulsePass<P extends PulsePhase = PulsePhase, I extends string = string> {
  id: I;
  readWorld: boolean;
  run(deps: PulseDeps, at: PulseReadings[P]): unknown;
}

interface PulseEntry<P extends PulsePhase = PulsePhase, I extends string = string> extends PulsePass<P, I> {
  phase: P;
}

function phase<P extends PulsePhase, const T extends readonly PulsePass<P>[]>(
  name: P,
  passes: T,
): { [K in keyof T]: T[K] & { phase: P } } {
  return passes.map((entry) => ({ ...entry, phase: name })) as { [K in keyof T]: T[K] & { phase: P } };
}

const ENTRIES = [
  ...phase('reconcile', [
    { id: 'plans', readWorld: true, run: (d, at) => d.plans?.reconcile(at.world) },
    { id: 'prWatch', readWorld: true, run: (d, at) => d.prWatch?.run(at.world) },
    { id: 'prWorkItems', readWorld: true, run: (d, at) => d.prWorkItems?.run(at.world) },
    { id: 'naming', readWorld: true, run: (d, at) => d.naming?.run(at.world) },
    { id: 'branchReaps', readWorld: true, run: (d, at) => d.branchReaps?.run(at.world) },
    { id: 'landings', readWorld: false, run: (d, at) => d.landings?.settle(at.world) },
    { id: 'validationAsks', readWorld: false, run: (d) => d.validationAsks?.run() },
    { id: 'schedules', readWorld: false, run: (d) => d.schedules?.run() },
    { id: 'updates', readWorld: true, run: (d) => d.updates?.run() },
    { id: 'graph', readWorld: false, run: (d, at) => d.graph?.record(at.world) },
    { id: 'environments', readWorld: true, run: (d, at) => d.environments?.run(at.world) },
    { id: 'remoteValidation', readWorld: true, run: (d) => d.remoteValidation?.run() },
    { id: 'validationReady', readWorld: false, run: (d, at) => d.validationReady?.run(at.world) },
    { id: 'closeOuts', readWorld: false, run: (d, at) => d.closeOuts?.run(at.world) },
    { id: 'notices', readWorld: true, run: (d, at) => d.notices?.run(at.previousWorld, at.world) },
    { id: 'graduations', readWorld: false, run: (d) => d.graduations?.run() },
    { id: 'clusters', readWorld: false, run: (d) => d.clusters?.run() },
    {
      id: 'obstacles',
      readWorld: false,
      run: (d, at) => d.obstacles?.run({ previousWorld: at.previousWorld, world: at.world, readWorld: at.readWorld }),
    },
    { id: 'pool', readWorld: true, run: (d) => d.pool?.run() },
  ]),
  ...phase('open', [
    { id: 'parks', readWorld: false, run: (d) => resumeExpiredParks(d) },
    { id: 'stalls', readWorld: false, run: (d) => d.fleet?.completeExpiredStalls() },
    { id: 'ejectionExpiries', readWorld: false, run: (d) => d.ejections?.sweepExpiries() },
  ]),
  ...phase('afterTasks', [{ id: 'reviewWaits', readWorld: false, run: (d, at) => foldReviewWaits(d, at) }]),
  ...phase('afterAgents', [
    { id: 'burn', readWorld: false, run: (d, at) => d.burn?.run({ agents: at.agents, tasks: at.tasks }) },
    { id: 'deadAgents', readWorld: false, run: (d) => d.escalations?.tidyDeadAgents() },
    { id: 'settledMerges', readWorld: false, run: (d) => d.escalations?.tidySettledMerges() },
  ]),
  ...phase('afterVerdicts', [
    { id: 'appraisals', readWorld: true, run: (d, at) => d.appraisals?.announce(at.world) },
    { id: 'areaPaths', readWorld: true, run: (d) => d.areaPaths?.refresh() },
  ]),
  ...phase('afterOrigins', [{ id: 'issueRuns', readWorld: false, run: (d, at) => recordIssueRuns(d, at) }]),
  ...phase('afterReviews', [
    { id: 'reviewedElsewhere', readWorld: true, run: (d, at) => askReviewedElsewhere(d, at) },
    { id: 'localValidations', readWorld: false, run: (d) => d.localValidations?.sweep() },
  ]),
  ...phase('afterExecute', [{ id: 'tickets', readWorld: true, run: (d) => d.tickets?.run() }]),
];

export type PulseId = (typeof ENTRIES)[number]['id'];

export const PULSE_PIPELINE: readonly PulseEntry[] = ENTRIES;

export const PULSE_PHASES: readonly PulsePhase[] = [
  'reconcile',
  'open',
  'afterTasks',
  'afterAgents',
  'afterVerdicts',
  'afterOrigins',
  'afterReviews',
  'afterExecute',
];

export async function runPulse<P extends PulsePhase>(
  phase: P,
  deps: PulseDeps,
  at: PulseReadings[P],
  readWorld: boolean,
): Promise<void> {
  for (const entry of PULSE_PIPELINE) {
    if (entry.phase !== phase) continue;
    if (entry.readWorld && !readWorld) continue;
    await entry.run(deps, at);
  }
}

function resumeExpiredParks(deps: PulseDeps): void {
  for (const { agentId, error } of deps.fleet?.resumeExpiredParks() ?? [])
    deps.errors.record({
      source: 'agent',
      message: `Agent ${agentId} could not be resumed after its usage limit cleared; it stays parked`,
      detail: error,
    });
}

function foldReviewWaits(deps: PulseDeps, at: PulseReadings['afterTasks']): void {
  deps.store.reviewWaits.foldReviewWaits(
    at.world.pullRequests
      .filter((pr) =>
        awaitingReview(
          pr,
          at.tasks.some((t) => isActiveTask(t) && t.branch === pr.branch),
        ),
      )
      .map((pr) => pr.number),
  );
}

function recordIssueRuns(deps: PulseDeps, at: PulseReadings['afterOrigins']): void {
  try {
    for (const r of runsToRecord(at.world.issues, at.tasks, at.signals)) deps.store.floor.recordIssueRun(r);
  } catch (err) {
    deps.errors.record({
      source: 'cycle',
      message: `Recording issue runs failed: ${(err as Error).message}`,
      detail: (err as Error).stack ?? null,
    });
  }
}
