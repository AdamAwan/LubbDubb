import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { foldWorkGraph } from './workGraph.js';

// → docs/spec/14-persistence.md#the-work-graph

interface WorkGraphRecorderDeps {
  store: Store;
  errors?: ErrorRecorder;
}

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
          filings: store.listWorkItemFilings(),
          existing: store.listWorkRoots().flatMap((root) => store.listWorkSubtree(root.ref)),
        }),
      );
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: 'failed to record the work graph',
        detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }
}
