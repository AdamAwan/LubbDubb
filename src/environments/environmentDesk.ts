import { issueOriginNumber } from '../issueOrigins.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { EnvironmentReachStatus, GoalLanding, WorldSnapshot } from '../types.js';
import { announceableArrivals, arrivalComment, newArrivals } from './arrival.js';
import type { EnvironmentHealthProber } from './healthProber.js';
import { unrecordedLandings } from './landings.js';
import type { EnvironmentConfig } from './policy.js';
import type { EnvironmentProber } from './prober.js';
import { allGoalReach } from './reach.js';
import { stuckGoals, stuckSaid } from './stuck.js';
import type { WatchDesk } from './watchDesk.js';

// → docs/spec/24-environments.md

interface EnvironmentDeskDeps {
  store: Store;
  environments: EnvironmentConfig[];
  prober: EnvironmentProber;
  healthProber: EnvironmentHealthProber;
  git: GitObserver;
  sink: ActionSink;
  integrationBranch: string;
  probeIntervalMs: number;
  healthIntervalMs: number;
  watch?: WatchDesk;
  errors?: ErrorRecorder;
  now?: () => number;
}

const MAX_LANDINGS_PER_PULSE = 200;

export class EnvironmentDesk {
  private readonly now: () => number;
  private readonly reported = new Set<string>();

  constructor(private readonly deps: EnvironmentDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async run(world: WorldSnapshot): Promise<void> {
    const { store, errors } = this.deps;
    try {
      for (const landing of unrecordedLandings({
        world,
        nodes: store.listWorkNodes(),
        landed: store.landedPrs(),
        integrationBranch: this.deps.integrationBranch,
      }))
        store.recordGoalLanding(landing);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `recording goal landings failed: ${(err as Error).message}` });
    }

    if (this.deps.environments.length === 0) return;
    for (const environment of this.deps.environments) await this.checkHealth(environment);
    await this.reconcile();
    for (const environment of this.deps.environments) await this.probe(environment);
    this.recordArrivals();
    this.reportStuck();
    await this.announce();
    await this.deps.watch?.run();
  }

  private async checkHealth(environment: EnvironmentConfig): Promise<void> {
    const { store, errors } = this.deps;
    const command = environment.health;
    if (command === undefined) return;
    const standing = store.listEnvironmentHealth().find((r) => r.environment === environment.name);
    const floor = new Date(this.now() - this.deps.healthIntervalMs).toISOString();
    if (standing !== undefined && standing.observedAt > floor) return;
    try {
      const report = await this.deps.healthProber.check(environment.name, command);
      store.recordEnvironmentHealth({ environment: environment.name, ...report });
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `checking the health of ${environment.name} failed: ${(err as Error).message}`,
      });
    }
  }

  private async reconcile(): Promise<void> {
    const { store, errors } = this.deps;
    const pending = store
      .listGoalLandings()
      .filter((l) => l.onIntegration === null)
      .slice(0, MAX_LANDINGS_PER_PULSE);
    if (pending.length === 0) return;
    try {
      const held = await this.deps.git.contains(
        pending.map((l) => l.sha),
        [this.deps.integrationBranch],
      );
      for (const landing of pending) {
        const answer = held.get(landing.sha) ?? null;
        if (answer === null) continue;
        store.markLandingIntegration(landing.prNumber, answer);
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `placing landings on ${this.deps.integrationBranch} failed: ${(err as Error).message}`,
      });
    }
  }

  private reportStuck(): void {
    const { store, errors } = this.deps;
    if (errors === undefined) return;
    try {
      const stuck = stuckGoals({
        delivered: store.listDeliveries().map((d) => d.originRef),
        shortfalled: new Set(store.listShortfalls().map((sf) => sf.originRef)),
        environments: this.deps.environments,
        arrivals: store.listGoalArrivals(),
        releases: store.listEnvironmentGateReleases(),
        landings: store.listGoalLandings(),
        readings: store.listEnvironmentReach(),
        probeIntervalMs: this.deps.probeIntervalMs,
        now: this.now(),
      });
      const open = new Set(stuck.map((s) => `${s.goalRef} ${s.environment}`));
      for (const key of [...this.reported]) if (!open.has(key)) this.reported.delete(key);
      for (const one of stuck) {
        const key = `${one.goalRef} ${one.environment}`;
        if (this.reported.has(key)) continue;
        this.reported.add(key);
        errors.record({ source: 'cycle', message: stuckSaid(one) });
      }
    } catch (err) {
      errors.record({ source: 'cycle', message: `reading held goals failed: ${(err as Error).message}` });
    }
  }

  private async probe(environment: EnvironmentConfig): Promise<void> {
    const { store, errors } = this.deps;
    const pending = this.due(environment.name);
    if (pending.length === 0) return;
    try {
      const head = await this.deps.prober.at(environment.name, environment.at);
      const detail = head.detail;
      const held =
        head.commits === null
          ? new Map<string, boolean | null>()
          : await this.deps.git.contains(
              pending.map((l) => l.sha),
              head.commits,
            );
      for (const landing of pending) {
        const answer = head.commits === null ? null : (held.get(landing.sha) ?? null);
        store.recordEnvironmentReach({
          sha: landing.sha,
          environment: environment.name,
          status: verdictOf(answer),
          detail: answer === null ? (detail ?? 'the clone could not place this commit') : null,
        });
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `probing ${environment.name} failed: ${(err as Error).message}`,
      });
    }
  }

  private due(environment: string): GoalLanding[] {
    const held = new Map(
      this.deps.store
        .listEnvironmentReach()
        .filter((r) => r.environment === environment)
        .map((r) => [r.sha, r]),
    );
    const floor = new Date(this.now() - this.deps.probeIntervalMs).toISOString();
    const out: GoalLanding[] = [];
    for (const landing of this.deps.store.listGoalLandings()) {
      if (landing.onIntegration === false) continue;
      const reading = held.get(landing.sha);
      if (reading?.status === 'reached') continue;
      if (reading !== undefined && reading.observedAt > floor) continue;
      out.push(landing);
      if (out.length >= MAX_LANDINGS_PER_PULSE) break;
    }
    return out;
  }

  private recordArrivals(): void {
    const { store, errors } = this.deps;
    try {
      const reach = allGoalReach({
        landings: store.listGoalLandings(),
        readings: store.listEnvironmentReach(),
        nodes: store.listWorkNodes(),
        landed: store.landedPrs(),
        plans: store.listPlans(),
        parts: store.listAllPlanParts(),
        environments: this.deps.environments,
      });
      for (const arrival of newArrivals({ reach, recorded: store.listGoalArrivals() }))
        store.recordGoalArrival(arrival);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `recording goal arrivals failed: ${(err as Error).message}` });
    }
  }

  private async announce(): Promise<void> {
    const { store, errors } = this.deps;
    const landings = store.listGoalLandings();
    for (const { arrival, comment, workItemState } of announceableArrivals({
      arrivals: store.listGoalArrivals(),
      environments: this.deps.environments,
      readings: store.listEnvironmentReach(),
      landings,
      probeIntervalMs: this.deps.probeIntervalMs,
      now: this.now(),
    })) {
      const number = issueNumber(arrival.goalRef);
      if (comment && number !== null) {
        try {
          await this.deps.sink.upsertIssueComment({
            number,
            body: arrivalComment({
              environment: arrival.environment,
              landings: landings.filter((l) => l.goalRef === arrival.goalRef).length,
              at: arrival.arrivedAt,
            }),
            commentRef: null,
          });
        } catch (err) {
          errors?.record({
            source: 'cycle',
            message: `commenting on ${arrival.goalRef} reaching ${arrival.environment} failed: ${(err as Error).message}`,
          });
          continue;
        }
      }
      if (workItemState !== null && number !== null) {
        try {
          await this.deps.sink.setWorkItemState({ number, state: workItemState });
        } catch (err) {
          errors?.record({
            source: 'cycle',
            message:
              `moving ${arrival.goalRef} to "${workItemState}" on reaching ${arrival.environment} failed: ` +
              `${(err as Error).message}`,
          });
          continue;
        }
      }
      store.markArrivalAnnounced(arrival.goalRef, arrival.environment);
    }
  }
}

function verdictOf(answer: boolean | null): EnvironmentReachStatus {
  if (answer === null) return 'unknown';
  return answer ? 'reached' : 'absent';
}

function issueNumber(goalRef: string): number | null {
  return issueOriginNumber('root', goalRef);
}
