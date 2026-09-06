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
import type { WatchDesk } from './watchDesk.js';

// → docs/spec/24-environments.md

interface EnvironmentDeskDeps {
  store: Store;
  environments: EnvironmentConfig[];
  prober: EnvironmentProber;
  healthProber: EnvironmentHealthProber;
  git: GitObserver;
  sink: ActionSink;
  probeIntervalMs: number;
  healthIntervalMs: number;
  watch?: WatchDesk;
  errors?: ErrorRecorder;
  now?: () => number;
}

const MAX_LANDINGS_PER_PULSE = 200;

export class EnvironmentDesk {
  private readonly now: () => number;

  constructor(private readonly deps: EnvironmentDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async run(world: WorldSnapshot): Promise<void> {
    const { store, errors } = this.deps;
    try {
      for (const landing of unrecordedLandings({ world, nodes: store.listWorkNodes(), landed: store.landedPrs() }))
        store.recordGoalLanding(landing);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `recording goal landings failed: ${(err as Error).message}` });
    }

    if (this.deps.environments.length === 0) return;
    for (const environment of this.deps.environments) await this.checkHealth(environment);
    for (const environment of this.deps.environments) await this.probe(environment);
    this.recordArrivals();
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
    for (const { arrival, comment } of announceableArrivals({
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
      store.markArrivalAnnounced(arrival.goalRef, arrival.environment);
    }
  }
}

function verdictOf(answer: boolean | null): EnvironmentReachStatus {
  if (answer === null) return 'unknown';
  return answer ? 'reached' : 'absent';
}

function issueNumber(goalRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(goalRef);
  return m?.[1] === undefined ? null : Number(m[1]);
}
