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
  obstacleVoice?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  obstacleDesk?: { run(): Promise<void> };
  obstacleNotices?: { run(): void };
  obstacleOwnership?: { run(world: WorldSnapshot): Promise<void> };
  obstacleEndings?: { run(world: WorldSnapshot): void };
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
  reconcile: { world: WorldSnapshot; previousWorld: WorldSnapshot | null };
  open: Record<string, never>;
  afterTasks: { world: WorldSnapshot; tasks: TaskSummary[] };
  afterAgents: { tasks: TaskSummary[]; agents: Agent[] };
  afterVerdicts: { world: WorldSnapshot };
  afterOrigins: { world: WorldSnapshot; tasks: TaskSummary[]; signals: CompletionSignals };
  afterReviews: { dispatchWorld: WorldSnapshot; prReviews: PrReview[]; prReviewRoutes: PrReviewRoute[] };
  afterExecute: Record<string, never>;
}

interface PulseEntry<P extends PulsePhase = PulsePhase, I extends string = string> {
  id: I;
  phase: P;
  readWorld: boolean;
  awaited: boolean;
  run(deps: PulseDeps, at: PulseReadings[P]): unknown;
}

function pass<P extends PulsePhase, I extends string>(entry: PulseEntry<P, I>): PulseEntry<P, I> {
  return entry;
}

const ENTRIES = [
  pass({
    id: 'plans',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.plans?.reconcile(at.world),
  }),
  pass({ id: 'prWatch', phase: 'reconcile', readWorld: true, awaited: true, run: (d, at) => d.prWatch?.run(at.world) }),
  pass({
    id: 'prWorkItems',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.prWorkItems?.run(at.world),
  }),
  pass({ id: 'naming', phase: 'reconcile', readWorld: true, awaited: true, run: (d, at) => d.naming?.run(at.world) }),
  pass({
    id: 'branchReaps',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.branchReaps?.run(at.world),
  }),
  pass({
    id: 'landings',
    phase: 'reconcile',
    readWorld: false,
    awaited: true,
    run: (d, at) => d.landings?.settle(at.world),
  }),
  pass({
    id: 'validationAsks',
    phase: 'reconcile',
    readWorld: false,
    awaited: true,
    run: (d) => d.validationAsks?.run(),
  }),
  pass({ id: 'schedules', phase: 'reconcile', readWorld: false, awaited: true, run: (d) => d.schedules?.run() }),
  pass({ id: 'updates', phase: 'reconcile', readWorld: true, awaited: true, run: (d) => d.updates?.run() }),
  pass({ id: 'graph', phase: 'reconcile', readWorld: false, awaited: true, run: (d, at) => d.graph?.record(at.world) }),
  pass({
    id: 'environments',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.environments?.run(at.world),
  }),
  pass({
    id: 'remoteValidation',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d) => d.remoteValidation?.run(),
  }),
  pass({
    id: 'validationReady',
    phase: 'reconcile',
    readWorld: false,
    awaited: true,
    run: (d, at) => d.validationReady?.run(at.world),
  }),
  pass({
    id: 'closeOuts',
    phase: 'reconcile',
    readWorld: false,
    awaited: true,
    run: (d, at) => d.closeOuts?.run(at.world),
  }),
  pass({
    id: 'notices',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.notices?.run(at.previousWorld, at.world),
  }),
  pass({ id: 'graduations', phase: 'reconcile', readWorld: false, awaited: true, run: (d) => d.graduations?.run() }),
  pass({ id: 'clusters', phase: 'reconcile', readWorld: false, awaited: true, run: (d) => d.clusters?.run() }),
  pass({
    id: 'obstacleVoice',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.obstacleVoice?.run(at.previousWorld, at.world),
  }),
  pass({ id: 'obstacleDesk', phase: 'reconcile', readWorld: false, awaited: false, run: (d) => d.obstacleDesk?.run() }),
  pass({
    id: 'obstacleNotices',
    phase: 'reconcile',
    readWorld: false,
    awaited: true,
    run: (d) => d.obstacleNotices?.run(),
  }),
  pass({
    id: 'obstacleOwnership',
    phase: 'reconcile',
    readWorld: false,
    awaited: true,
    run: (d, at) => d.obstacleOwnership?.run(at.world),
  }),
  pass({
    id: 'obstacleEndings',
    phase: 'reconcile',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.obstacleEndings?.run(at.world),
  }),
  pass({ id: 'pool', phase: 'reconcile', readWorld: true, awaited: true, run: (d) => d.pool?.run() }),
  pass({ id: 'parks', phase: 'open', readWorld: false, awaited: true, run: (d) => resumeExpiredParks(d) }),
  pass({ id: 'stalls', phase: 'open', readWorld: false, awaited: true, run: (d) => d.fleet?.completeExpiredStalls() }),
  pass({
    id: 'ejectionExpiries',
    phase: 'open',
    readWorld: false,
    awaited: true,
    run: (d) => d.ejections?.sweepExpiries(),
  }),
  pass({
    id: 'reviewWaits',
    phase: 'afterTasks',
    readWorld: false,
    awaited: true,
    run: (d, at) => foldReviewWaits(d, at),
  }),
  pass({
    id: 'burn',
    phase: 'afterAgents',
    readWorld: false,
    awaited: true,
    run: (d, at) => d.burn?.run({ agents: at.agents, tasks: at.tasks }),
  }),
  pass({
    id: 'deadAgents',
    phase: 'afterAgents',
    readWorld: false,
    awaited: true,
    run: (d) => d.escalations?.tidyDeadAgents(),
  }),
  pass({
    id: 'settledMerges',
    phase: 'afterAgents',
    readWorld: false,
    awaited: true,
    run: (d) => d.escalations?.tidySettledMerges(),
  }),
  pass({
    id: 'appraisals',
    phase: 'afterVerdicts',
    readWorld: true,
    awaited: true,
    run: (d, at) => d.appraisals?.announce(at.world),
  }),
  pass({ id: 'areaPaths', phase: 'afterVerdicts', readWorld: true, awaited: true, run: (d) => d.areaPaths?.refresh() }),
  pass({
    id: 'issueRuns',
    phase: 'afterOrigins',
    readWorld: false,
    awaited: true,
    run: (d, at) => recordIssueRuns(d, at),
  }),
  pass({
    id: 'reviewedElsewhere',
    phase: 'afterReviews',
    readWorld: true,
    awaited: true,
    run: (d, at) => askReviewedElsewhere(d, at),
  }),
  pass({
    id: 'localValidations',
    phase: 'afterReviews',
    readWorld: false,
    awaited: true,
    run: (d) => d.localValidations?.sweep(),
  }),
  pass({ id: 'tickets', phase: 'afterExecute', readWorld: true, awaited: true, run: (d) => d.tickets?.run() }),
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
    if (entry.awaited) await entry.run(deps, at);
    else void entry.run(deps, at);
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
