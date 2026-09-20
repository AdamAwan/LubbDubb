import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { issueOriginRef } from '../issueOrigins.js';
import { featureGroups } from '../sequence/sequence.js';
import { sequenceReadiness } from '../sequence/readiness.js';
import type { Issue, WorldSnapshot } from '../types.js';
import { unwatchedChildFindings, type UnwatchedFeature } from './unwatchedChildren.js';

// → docs/spec/06-issue-pickup.md#a-watched-feature-reports-the-children-nothing-can-see

interface UnwatchedDeskDeps {
  store: Store;
  containerTypes: readonly string[] | undefined;
  watched: (issue: Issue) => boolean;
  errors?: ErrorRecorder;
}

/**
 * One "Needs you" row per watched Feature with a story the fleet cannot see.
 *
 * `WatchDesk`'s shape (`src/environments/watchDesk.ts`) — a pure reconciliation against the rows
 * already filed, so a repeat folds onto the row it wrote and only the answer ends it. It reads the
 * world and writes human tasks; it holds nothing, dispatches nothing, and writes no tag anywhere.
 */
export class UnwatchedChildDesk {
  constructor(private readonly deps: UnwatchedDeskDeps) {}

  /** @public the pass the pulse runs below `closeOuts` */
  run(world: WorldSnapshot): void {
    const { store, errors } = this.deps;
    try {
      // An empty snapshot is a provider that failed on a first boot, not a tracker with no work.
      // Settling every standing row off it is the one way this can be wrong at scale.
      if (world.issues.length === 0) return;
      const steps = unwatchedChildFindings({
        features: this.readFeatures(world),
        existing: store.humanTasks.listHumanTasksOfKind('unwatched'),
      });
      for (const step of steps) {
        if (step.kind === 'file')
          store.humanTasks.recordHumanTask({
            title: step.title,
            detail: step.detail,
            originRef: step.originRef,
            kind: 'unwatched',
            agentId: null,
            taskId: null,
          });
        else if (step.kind === 'reopen') store.humanTasks.reopenHumanTask(step.taskId, step.detail);
        else store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `filing unwatched-child findings failed: ${(err as Error).message}`,
      });
    }
  }

  private readFeatures(world: WorldSnapshot): UnwatchedFeature[] {
    const groups = featureGroups(world.issues, this.deps.containerTypes, this.deps.watched);
    const sequences = new Map(this.deps.store.sequences.listFeatureSequences().map((s) => [s.originRef, s]));
    return groups.map((group) => {
      const standing = sequences.get(issueOriginRef('root', group.feature.number)) ?? null;
      const edges =
        standing !== null && standing.status === 'accepted'
          ? standing.edges.map((e) => ({ issue: e.issue, dependsOn: e.dependsOn }))
          : [];
      const behind = new Set<number>();
      for (const wait of sequenceReadiness(edges, {
        issues: world.issues,
        watched: this.deps.watched,
      }).values()) {
        for (const number of wait.unworkable) behind.add(number);
      }
      return {
        number: group.feature.number,
        originRef: issueOriginRef('root', group.feature.number),
        title: group.feature.title,
        unwatched: group.unwatched,
        open: group.children.length,
        holding: group.unwatched.filter((n) => behind.has(n)),
      };
    });
  }
}
