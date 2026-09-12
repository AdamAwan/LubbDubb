import type { ErrorRecorder } from '../errorLog.js';
import { dispatchFactScopes } from '../knowledge/block.js';
import { corroborationGoal } from '../knowledge/knowledge.js';
import type { Store } from '../store/store.js';
import { type DeliverableObstacle } from './delivery.js';
import { obstacleNotices, type NoticeAgent } from './notices.js';

// → docs/spec/27-obstacles.md

interface NoticeFleet {
  isLive(agentId: string): boolean;
  notify(agentId: string, text: string): boolean;
}

export class ObstacleNoticeDesk {
  constructor(private readonly deps: { store: Store; fleet: NoticeFleet; errors?: ErrorRecorder }) {}

  run(): void {
    try {
      const rows = this.board();
      if (rows.length === 0) return;
      for (const notice of obstacleNotices(rows, this.liveAgents(rows))) {
        if (!this.deps.store.obstacles.claimObstacleNotice(notice.obstacleId, notice.agentId, notice.reason)) continue;
        this.deps.fleet.notify(notice.agentId, notice.text);
      }
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Sending obstacle notices failed: ${(err as Error).message}`,
      });
    }
  }

  private board(): DeliverableObstacle[] {
    return this.deps.store.obstacles
      .listObstacles()
      .map((obstacle) => ({ obstacle, keys: this.deps.store.obstacles.listObstacleKeys(obstacle.id) }));
  }

  private liveAgents(rows: readonly DeliverableObstacle[]): NoticeAgent[] {
    const out: NoticeAgent[] = [];
    for (const agent of this.deps.store.agents.listAgents()) {
      if (!this.deps.fleet.isLive(agent.id)) continue;
      const task = this.deps.store.tasks.getTask(agent.taskId);
      if (!task) continue;
      const goalRef = corroborationGoal(task.originRef);
      const reported = new Set(
        rows
          .filter((row) =>
            this.deps.store.obstacles
              .listObstacleSightings(row.obstacle.id)
              .some((s) => s.agentId === agent.id || (goalRef !== null && s.goalRef === goalRef)),
          )
          .map((row) => row.obstacle.id),
      );
      out.push({
        agentId: agent.id,
        goalRef,
        scopes: dispatchFactScopes(task.originRef, task.ciChecks ?? null),
        reported,
        notified: this.deps.store.obstacles.obstaclesNoticedBy(agent.id),
      });
    }
    return out;
  }
}
