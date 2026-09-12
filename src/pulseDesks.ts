import type { Agent, PrReview, PrReviewRoute, TaskSummary, WorldSnapshot } from './types.js';
import type { Store } from './store/store.js';
import type { ErrorRecorder } from './errorLog.js';
import type { LimitResumeFailure } from './agents/agentManager.js';
import type { AppraisalDesk } from './intake/appraisalDesk.js';
import type { AreaPathDirectory } from './intake/areaPaths.js';
import type { SpendBurnDesk } from './spendBurnDesk.js';
import type { PrReviewPolicy } from './review/policy.js';
import { askReviewedElsewhere, type ReviewProber } from './review/reviewedElsewhere.js';
import { awaitingReview } from './prHealth.js';
import { isActiveTask } from './tasks.js';
import { runsToRecord, type CompletionSignals } from './floor/runs.js';
import type { PlanReconciler } from './plans/planReconciler.js';
import type { PrNamingDesk } from './prNamingDesk.js';
import type { PrWatchDesk } from './prWatchDesk.js';
import type { PrWorkItemDesk } from './prWorkItemDesk.js';
import type { BranchReapDesk } from './branchReapDesk.js';
import type { StackLandingDesk } from './stacks/landingDesk.js';
import type { ValidationAskDesk } from './validation/askDesk.js';
import type { ValidationReadyDesk } from './validation/readyDesk.js';
import type { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import type { ScheduleDesk } from './schedules/scheduleDesk.js';
import type { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import type { EnvironmentDesk } from './environments/environmentDesk.js';
import type { RemoteValidationDesk } from './remoteValidation/desk.js';
import type { PoolDesk } from './pool/poolDesk.js';

// → docs/spec/04-harness-cycle.md

export interface PulseDeskDeps {
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
  obstacleVoice?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  obstacleDesk?: { run(): Promise<void> };
  obstacleNotices?: { run(): void };
  obstacleOwnership?: { run(world: WorldSnapshot): Promise<void> };
  obstacleEndings?: { run(world: WorldSnapshot): void };
  pool?: PoolDesk;
}

export type PulseDeskId = keyof PulseDeskDeps;

export interface PulseReading {
  world: WorldSnapshot;
  previousWorld: WorldSnapshot | null;
}

interface PulseDesk {
  readWorld: boolean;
  awaited: boolean;
  run(deps: PulseDeskDeps, at: PulseReading): unknown;
}

export const PULSE_DESKS: Record<PulseDeskId, PulseDesk> = {
  plans: { readWorld: true, awaited: true, run: (d, at) => d.plans?.reconcile(at.world) },
  prWatch: { readWorld: true, awaited: true, run: (d, at) => d.prWatch?.run(at.world) },
  prWorkItems: { readWorld: true, awaited: true, run: (d, at) => d.prWorkItems?.run(at.world) },
  naming: { readWorld: true, awaited: true, run: (d, at) => d.naming?.run(at.world) },
  branchReaps: { readWorld: true, awaited: true, run: (d, at) => d.branchReaps?.run(at.world) },
  landings: { readWorld: false, awaited: true, run: (d, at) => d.landings?.settle(at.world) },
  validationAsks: { readWorld: false, awaited: true, run: (d) => d.validationAsks?.run() },
  schedules: { readWorld: false, awaited: true, run: (d) => d.schedules?.run() },
  updates: { readWorld: true, awaited: true, run: (d) => d.updates?.run() },
  graph: { readWorld: false, awaited: true, run: (d, at) => d.graph?.record(at.world) },
  environments: { readWorld: true, awaited: true, run: (d, at) => d.environments?.run(at.world) },
  remoteValidation: { readWorld: true, awaited: true, run: (d) => d.remoteValidation?.run() },
  validationReady: { readWorld: false, awaited: true, run: (d, at) => d.validationReady?.run(at.world) },
  closeOuts: { readWorld: false, awaited: true, run: (d, at) => d.closeOuts?.run(at.world) },
  notices: { readWorld: true, awaited: true, run: (d, at) => d.notices?.run(at.previousWorld, at.world) },
  graduations: { readWorld: false, awaited: true, run: (d) => d.graduations?.run() },
  clusters: { readWorld: false, awaited: true, run: (d) => d.clusters?.run() },
  obstacleVoice: { readWorld: true, awaited: true, run: (d, at) => d.obstacleVoice?.run(at.previousWorld, at.world) },
  obstacleDesk: { readWorld: false, awaited: false, run: (d) => d.obstacleDesk?.run() },
  obstacleNotices: { readWorld: false, awaited: true, run: (d) => d.obstacleNotices?.run() },
  obstacleOwnership: { readWorld: false, awaited: true, run: (d, at) => d.obstacleOwnership?.run(at.world) },
  obstacleEndings: { readWorld: true, awaited: true, run: (d, at) => d.obstacleEndings?.run(at.world) },
  pool: { readWorld: true, awaited: true, run: (d) => d.pool?.run() },
};

export const PULSE_PIPELINE: readonly PulseDeskId[] = [
  'plans',
  'prWatch',
  'prWorkItems',
  'naming',
  'branchReaps',
  'landings',
  'validationAsks',
  'schedules',
  'updates',
  'graph',
  'environments',
  'remoteValidation',
  'validationReady',
  'closeOuts',
  'notices',
  'graduations',
  'clusters',
  'obstacleVoice',
  'obstacleDesk',
  'obstacleNotices',
  'obstacleOwnership',
  'obstacleEndings',
  'pool',
];

export async function runPulseDesks(deps: PulseDeskDeps, at: PulseReading, readWorld: boolean): Promise<void> {
  for (const id of PULSE_PIPELINE) {
    const desk = PULSE_DESKS[id];
    if (desk.readWorld && !readWorld) continue;
    if (desk.awaited) await desk.run(deps, at);
    else void desk.run(deps, at);
  }
}

export interface PulseSweepDeps {
  store: Store;
  errors: ErrorRecorder;
  review: PrReviewPolicy;
  reviewProber?: ReviewProber;
  fleet?: { resumeExpiredParks(): LimitResumeFailure[]; completeExpiredStalls(): string[] };
  ejections?: { sweepExpiries(): unknown[] };
  burn?: SpendBurnDesk;
  escalations?: { tidyDeadAgents(): unknown[]; tidySettledMerges(): unknown[] };
  appraisals?: AppraisalDesk;
  areaPaths?: AreaPathDirectory;
  localValidations?: { sweep(): void };
  tickets?: { run(): Promise<void> };
}

type PulseSweepPhase =
  | 'open'
  | 'afterTasks'
  | 'afterAgents'
  | 'afterVerdicts'
  | 'afterOrigins'
  | 'afterReviews'
  | 'afterExecute';

interface PulseSweepReadings {
  open: Record<string, never>;
  afterTasks: { world: WorldSnapshot; tasks: TaskSummary[] };
  afterAgents: { tasks: TaskSummary[]; agents: Agent[] };
  afterVerdicts: { world: WorldSnapshot };
  afterOrigins: { world: WorldSnapshot; tasks: TaskSummary[]; signals: CompletionSignals };
  afterReviews: { dispatchWorld: WorldSnapshot; prReviews: PrReview[]; prReviewRoutes: PrReviewRoute[] };
  afterExecute: Record<string, never>;
}

type PulseSweepId =
  | 'parks'
  | 'stalls'
  | 'ejectionExpiries'
  | 'reviewWaits'
  | 'burn'
  | 'deadAgents'
  | 'settledMerges'
  | 'appraisals'
  | 'areaPaths'
  | 'issueRuns'
  | 'reviewedElsewhere'
  | 'localValidations'
  | 'tickets';

interface PulseSweep<P extends PulseSweepPhase = PulseSweepPhase> {
  phase: P;
  readWorld: boolean;
  awaited: boolean;
  run(deps: PulseSweepDeps, at: PulseSweepReadings[P]): unknown;
}

function sweep<P extends PulseSweepPhase>(entry: PulseSweep<P>): PulseSweep<P> {
  return entry;
}

export const PULSE_SWEEPS: Record<PulseSweepId, PulseSweep> = {
  parks: sweep({ phase: 'open', readWorld: false, awaited: true, run: (d) => resumeExpiredParks(d) }),
  stalls: sweep({ phase: 'open', readWorld: false, awaited: true, run: (d) => d.fleet?.completeExpiredStalls() }),
  ejectionExpiries: sweep({ phase: 'open', readWorld: false, awaited: true, run: (d) => d.ejections?.sweepExpiries() }),
  reviewWaits: sweep({ phase: 'afterTasks', readWorld: false, awaited: true, run: (d, at) => foldReviewWaits(d, at) }),
  burn: sweep({
    phase: 'afterAgents',
    readWorld: false,
    awaited: true,
    run: (d, at) => d.burn?.run({ agents: at.agents, tasks: at.tasks }),
  }),
  deadAgents: sweep({
    phase: 'afterAgents',
    readWorld: false,
    awaited: true,
    run: (d) => d.escalations?.tidyDeadAgents(),
  }),
  settledMerges: sweep({
    phase: 'afterAgents',
    readWorld: false,
    awaited: true,
    run: (d) => d.escalations?.tidySettledMerges(),
  }),
  appraisals: sweep({
    phase: 'afterVerdicts',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.appraisals?.announce(at.world),
  }),
  areaPaths: sweep({ phase: 'afterVerdicts', readWorld: true, awaited: true, run: (d) => d.areaPaths?.refresh() }),
  issueRuns: sweep({ phase: 'afterOrigins', readWorld: false, awaited: true, run: (d, at) => recordIssueRuns(d, at) }),
  reviewedElsewhere: sweep({
    phase: 'afterReviews',
    readWorld: true,
    awaited: true,
    run: (d, at) => askReviewedElsewhere(d, at),
  }),
  localValidations: sweep({
    phase: 'afterReviews',
    readWorld: false,
    awaited: true,
    run: (d) => d.localValidations?.sweep(),
  }),
  tickets: sweep({ phase: 'afterExecute', readWorld: true, awaited: true, run: (d) => d.tickets?.run() }),
};

export const PULSE_SWEEP_PHASES: readonly PulseSweepPhase[] = [
  'open',
  'afterTasks',
  'afterAgents',
  'afterVerdicts',
  'afterOrigins',
  'afterReviews',
  'afterExecute',
];

export const PULSE_SWEEP_PIPELINE: readonly PulseSweepId[] = [
  'parks',
  'stalls',
  'ejectionExpiries',
  'reviewWaits',
  'burn',
  'deadAgents',
  'settledMerges',
  'appraisals',
  'areaPaths',
  'issueRuns',
  'reviewedElsewhere',
  'localValidations',
  'tickets',
];

export async function runPulseSweeps<P extends PulseSweepPhase>(
  phase: P,
  deps: PulseSweepDeps,
  at: PulseSweepReadings[P],
  readWorld: boolean,
): Promise<void> {
  for (const id of PULSE_SWEEP_PIPELINE) {
    const entry = PULSE_SWEEPS[id];
    if (entry.phase !== phase) continue;
    if (entry.readWorld && !readWorld) continue;
    if (entry.awaited) await entry.run(deps, at);
    else void entry.run(deps, at);
  }
}

function resumeExpiredParks(deps: PulseSweepDeps): void {
  for (const { agentId, error } of deps.fleet?.resumeExpiredParks() ?? [])
    deps.errors.record({
      source: 'agent',
      message: `Agent ${agentId} could not be resumed after its usage limit cleared; it stays parked`,
      detail: error,
    });
}

function foldReviewWaits(deps: PulseSweepDeps, at: PulseSweepReadings['afterTasks']): void {
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

function recordIssueRuns(deps: PulseSweepDeps, at: PulseSweepReadings['afterOrigins']): void {
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
