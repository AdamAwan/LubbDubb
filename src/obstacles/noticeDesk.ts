import type { ErrorRecorder } from '../errorLog.js';
import { dispatchFactScopes } from '../knowledge/block.js';
import { corroborationGoal } from '../knowledge/knowledge.js';
import type { Store } from '../store/store.js';
import { type DeliverableObstacle } from './delivery.js';
import { obstacleNotices, type NoticeAgent } from './notices.js';

/** What the desk needs of the fleet: who is live, and one way to type into them. */
interface NoticeFleet {
  isLive(agentId: string): boolean;
  /**
   * Type a harness message into a live agent, which lands at the next turn
   * boundary. Never `respond`: that ends a park, and a notice is not an answer to
   * anything the agent asked.
   */
  notify(agentId: string, text: string): boolean;
}

/**
 * The desk behind the mid-session channel: it sends what
 * {@link obstacleNotices} says is owed, and records each send before it makes it.
 *
 * **It decides nothing.** Which notices are owed is a pure function of the board
 * and the fleet; this reads the two, claims each notice against the once-ever
 * ledger, and types. A claim that is not won — because a previous pulse already
 * took it — sends nothing, which is what makes the rule a constraint rather than
 * an intention.
 *
 * On the pulse and not in `src/dispatcher/` for `notices`' reason: it staffs
 * nobody, holds nothing, and no rule reads what it writes.
 * → `docs/spec/27-obstacles.md#delivery`
 */
export class ObstacleNoticeDesk {
  constructor(private readonly deps: { store: Store; fleet: NoticeFleet; errors?: ErrorRecorder }) {}

  run(): void {
    try {
      const rows = this.board();
      if (rows.length === 0) return;
      for (const notice of obstacleNotices(rows, this.liveAgents(rows))) {
        // The claim comes first: a crash between the two loses a notice to an
        // agent that is in all likelihood already gone, where the other order
        // would send it twice — and a notice that arrives twice reads as a second
        // problem.
        if (!this.deps.store.claimObstacleNotice(notice.obstacleId, notice.agentId, notice.reason)) continue;
        this.deps.fleet.notify(notice.agentId, notice.text);
      }
    } catch (err) {
      // Never into the cycle. A channel that could fail a pulse would be a channel
      // an operator turns off, and then the one message that mattered is the one
      // nobody gets.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Sending obstacle notices failed: ${(err as Error).message}`,
      });
    }
  }

  /** Every row on the board, with the keys that are the ways into it. */
  private board(): DeliverableObstacle[] {
    return this.deps.store
      .listObstacles()
      .map((obstacle) => ({ obstacle, keys: this.deps.store.listObstacleKeys(obstacle.id) }));
  }

  /**
   * The live agents, each with what its dispatch is about and what it has already
   * said or been told.
   *
   * **A voice is a goal**, so an agent counts as having reported anything its own
   * goal reported: `corroborationGoal` is the harness's one spelling of that
   * collapse, and a re-dispatch on the same goal is not a party to be told what
   * that goal itself said.
   */
  private liveAgents(rows: readonly DeliverableObstacle[]): NoticeAgent[] {
    const out: NoticeAgent[] = [];
    for (const agent of this.deps.store.listAgents()) {
      if (!this.deps.fleet.isLive(agent.id)) continue;
      const task = this.deps.store.getTask(agent.taskId);
      if (!task) continue;
      const goalRef = corroborationGoal(task.originRef);
      const reported = new Set(
        rows
          .filter((row) =>
            this.deps.store
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
        notified: this.deps.store.obstaclesNoticedBy(agent.id),
      });
    }
    return out;
  }
}
