import type { WorldSnapshot } from './types.js';
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
