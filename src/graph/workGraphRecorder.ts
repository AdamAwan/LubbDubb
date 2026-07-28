import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { foldWorkGraph } from './workGraph.js';

interface WorkGraphRecorderDeps {
  store: Store;
  errors?: ErrorRecorder;
}

/**
 * Writes the durable work graph once per pulse.
 *
 * Thin on purpose: it gathers the store rows the fold needs, runs the pure fold and
 * hands the result to the store. All the reasoning is in {@link foldWorkGraph}, so
 * it is testable with no database and no world.
 *
 * **A failure here never fails the cycle.** Nothing in stage 1 reads the graph for a
 * decision, so a recorder that throws must cost an error-log entry and nothing else.
 */
export class WorkGraphRecorder {
  constructor(private readonly deps: WorkGraphRecorderDeps) {}

  record(world: WorldSnapshot): void {
    const { store, errors } = this.deps;
    try {
      store.recordWorkGraph(
        foldWorkGraph({
          world,
          tasks: store.listTasks(),
          plans: store.listPlans(),
          parts: store.listAllPlanParts(),
          jobs: store.listJobs(),
          // The graph as it stands, which is what "observed beats inferred" reads.
          // Rows still on disk from before the graph existed (tasks, plans, parts)
          // seed it on the first pass through the ordinary upsert — a wider input,
          // not a migration.
          existing: store.listWorkRoots().flatMap((root) => store.listWorkSubtree(root.ref)),
        }),
      );
    } catch (err) {
      // `source` is the pulse: the recorder has no life outside one, and a failure
      // here is a cycle that did less than it should, not a new class of fault.
      errors?.record({
        source: 'cycle',
        message: 'failed to record the work graph',
        detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }
}
