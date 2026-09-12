import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { gateKeys } from './keys.js';
import { harnessSightings } from './voice.js';
import { buildObstacleWorld, reportedChecks } from './world.js';

// → docs/spec/27-obstacles.md

export class ObstacleVoiceDesk {
  constructor(private readonly deps: { store: Store; errors?: ErrorRecorder }) {}

  run(prev: WorldSnapshot | null, next: WorldSnapshot): void {
    try {
      const sightings = harnessSightings(prev, next);
      if (sightings.length === 0) return;
      const reported = reportedChecks(next);
      const held = this.checkKeysHeld();
      for (const seen of sightings) {
        if (held.has(seen.checkName)) continue;
        const world = buildObstacleWorld({
          reported,
          dispatchChecks: [seen.checkName],
          branchPaths: [],
          repoRoot: null,
        });
        const keys = gateKeys([{ kind: 'check', value: seen.checkName }], world);
        if (!keys.some((key) => key.kind === 'check' && key.binds)) continue;
        this.deps.store.obstacles.recordObstacleSighting(
          { what: seen.what, kind: 'obstacle', keys, untilHours: null },
          {
            agentId: null,
            taskId: null,
            goalRef: null,
            sessionId: null,
            transition: seen.transition,
            words: seen.words,
            whyNotMine: null,
          },
        );
        held.add(seen.checkName);
      }
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Recording the harness's own obstacle sightings failed: ${(err as Error).message}`,
      });
    }
  }

  private checkKeysHeld(): Set<string> {
    const out = new Set<string>();
    for (const obstacle of this.deps.store.obstacles.listObstacles())
      for (const key of this.deps.store.obstacles.listObstacleKeys(obstacle.id))
        if (key.kind === 'check') out.add(key.value);
    return out;
  }
}
