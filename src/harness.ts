import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { Heartbeat } from './heartbeat.js';
import type { Store } from './store/store.js';
import type { Connector } from './connector/connector.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import type { ActionExecutor, ExecutionSummary } from './executor/actionExecutor.js';
import { diffWorlds } from './world/worldDiff.js';
import type { Action, WorldEvent, WorldSnapshot } from './types.js';

export interface HarnessDeps {
  store: Store;
  connector: Connector;
  dispatcher: Dispatcher;
  executor: ActionExecutor;
  heartbeatIntervalMs: number;
  maxConcurrentAgents: number;
  steeringPriorities: string[];
}

export interface CycleReport {
  cycleId: string;
  source: 'timer' | 'manual' | 'boot';
  rationale: string;
  summary: ExecutionSummary;
  at: string;
}

/**
 * The heart of the system: each pulse takes a snapshot of the world and the
 * fleet, asks the dispatcher what to do, and runs the result through the
 * executor. It records the dispatcher's free-form rationale to the audit log so
 * every cycle — even an idle one — is explainable after the fact.
 */
interface HarnessEvents {
  'cycle:start': [{ cycleId: string; source: string }];
  'cycle:end': [CycleReport];
  'world:events': [{ events: WorldEvent[] }];
}

export class Harness extends EventEmitter {
  private readonly heartbeat: Heartbeat;
  private cycleInFlight = false;
  // Last snapshot we diffed against. Seeded from the persisted baseline on the
  // first cycle so a restart doesn't re-emit the whole world as "new".
  private prevWorld: WorldSnapshot | null = null;

  constructor(private readonly deps: HarnessDeps) {
    super();
    this.heartbeat = new Heartbeat(deps.heartbeatIntervalMs, async (source) => {
      await this.runCycle(source);
    });
  }

  start(): void {
    this.heartbeat.start();
  }

  stop(): void {
    this.heartbeat.stop();
  }

  /** Trigger a cycle immediately (used when an event is injected). */
  async pulse(): Promise<void> {
    await this.heartbeat.trigger();
  }

  async runCycle(source: 'timer' | 'manual' | 'boot' = 'manual'): Promise<CycleReport> {
    if (this.cycleInFlight) {
      return {
        cycleId: 'coalesced',
        source,
        rationale: 'cycle already running',
        summary: { cycleId: 'coalesced', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    this.cycleInFlight = true;
    const cycleId = `cyc_${nanoid(8)}`;
    this.emit('cycle:start', { cycleId, source });
    try {
      const { store } = this.deps;
      const world = await this.deps.connector.getState();
      this.recordWorldChanges(store, world);
      const tasks = store.listTasks();
      const agents = store.listAgents();
      const openEscalations = store.listOpenEscalations();
      const recentDecisions = store.listDecisions(200);
      const headroom = Math.max(0, this.deps.maxConcurrentAgents - store.countLiveAgents());

      const plan = await this.deps.dispatcher.decide({
        world,
        tasks,
        agents,
        openEscalations,
        recentDecisions,
        steeringPriorities: this.deps.steeringPriorities,
        agentHeadroom: headroom,
      });

      // The dispatcher's reasoning is itself an audit record.
      store.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'cycle rationale' } as Action,
        outcome: 'skipped',
        detail: `[${source}] ${plan.rationale}`,
      });

      const summary = await this.deps.executor.execute(cycleId, plan);
      const report: CycleReport = { cycleId, source, rationale: plan.rationale, summary, at: new Date().toISOString() };
      this.emit('cycle:end', report);
      return report;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * Diff this cycle's world against the previous snapshot, persist every observed
   * transition, and stream them to the cockpit. The very first cycle over a fresh
   * store has no baseline → it only records the baseline (no diff, no spurious
   * "everything is new" flood).
   */
  private recordWorldChanges(store: HarnessDeps['store'], world: WorldSnapshot): void {
    const prev = this.prevWorld ?? store.getWorldBaseline();
    if (prev) {
      const changes = diffWorlds(prev, world);
      if (changes.length) {
        const events = store.recordWorldEvents(changes);
        this.emit('world:events', { events });
      }
    }
    this.prevWorld = world;
    store.setWorldBaseline(world);
  }

  // Typed emit/on overrides for a nicer call site (repo convention).
  override emit<K extends keyof HarnessEvents>(event: K, ...args: HarnessEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HarnessEvents>(event: K, listener: (...args: HarnessEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
