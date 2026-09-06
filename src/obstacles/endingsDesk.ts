import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { ObstacleStanding, WorldSnapshot } from '../types.js';
import {
  clockExpired,
  conditionMet,
  conditionsSettled,
  conditionsToWatch,
  decayed,
  noteWriteUpFields,
  notesToWriteUp,
  ownerLanded,
  writeUpReading,
} from './endings.js';

// → docs/spec/27-obstacles.md

type DocsPrompt = (vars: Record<string, string>) => string;

export class ObstacleEndingsDesk {
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      dormantMs: number;
      docsPrompt?: DocsPrompt;
      now?: () => number;
      errors?: ErrorRecorder;
    },
  ) {}

  run(world: WorldSnapshot): void {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const board = this.deps.store.obstacleBoard();
      for (const condition of conditionsToWatch(board, world.pullRequests))
        this.deps.store.watchObstacleCondition(condition);
      this.settleConditions(board, world);
      this.settleLandings(board);
      this.expire(board, now);
      this.decay(board, now);
      this.sweepWriteUps();
      this.writeUpNotes();
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Ending obstacles failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  private settleConditions(board: readonly ObstacleStanding[], world: WorldSnapshot): void {
    for (const row of board) {
      const conditions = this.deps.store.listObstacleConditions(row.obstacle.id);
      if (conditions.length === 0) continue;
      const settledBefore = conditions.every((condition) => condition.metAt !== null);
      for (const condition of conditions)
        this.deps.store.setObstacleConditionMet(condition.id, conditionMet(condition, world.pullRequests));
      if (settledBefore && conditionsSettled(conditions, world.pullRequests))
        this.deps.store.endObstacle(row.obstacle.id, 'resolved', 'condition');
    }
  }

  private settleLandings(board: readonly ObstacleStanding[]): void {
    const owned = board.filter((row) => row.obstacle.state === 'owned' && row.obstacle.ownerRef !== null);
    if (owned.length === 0) return;
    const landings = this.deps.store.listGoalLandings();
    for (const row of owned)
      if (ownerLanded(row.obstacle, landings)) this.deps.store.endObstacle(row.obstacle.id, 'resolved', 'landing');
  }

  private expire(board: readonly ObstacleStanding[], now: number): void {
    for (const row of board)
      if (clockExpired(row.obstacle, now)) this.deps.store.endObstacle(row.obstacle.id, 'resolved', 'expiry');
  }

  private decay(board: readonly ObstacleStanding[], now: number): void {
    for (const row of board)
      if (decayed(row.obstacle, now, this.deps.dormantMs))
        this.deps.store.endObstacle(row.obstacle.id, 'dormant', 'decay');
  }

  private sweepWriteUps(): void {
    const open = this.deps.store.openObstacleWriteUps();
    if (open.length === 0) return;
    for (const writeUp of open) {
      const nodes = this.deps.store.listWorkSubtree(`job:${writeUp.jobId}`);
      const pr = nodes.find((node) => node.kind === 'pr');
      if (pr && writeUp.prRef === null) this.deps.store.noteObstacleWriteUpPr(writeUp.obstacleId, pr.ref);
      const reading = writeUpReading(writeUp.jobId, nodes);
      if (reading !== 'landed' && reading !== 'abandoned') continue;
      if (!this.deps.store.settleObstacleWriteUp(writeUp.obstacleId, reading)) continue;
      if (reading === 'landed') this.deps.store.endObstacle(writeUp.obstacleId, 'resolved', 'written-down');
    }
  }

  private writeUpNotes(): void {
    const docs = this.deps.docsPrompt;
    if (!docs) return;
    if (this.deps.store.openObstacleWriteUps().length > 0) return;
    const row = notesToWriteUp(this.deps.store.obstacleBoard(), this.deps.store.obstaclesWrittenUp())[0];
    if (!row) return;
    const fields = noteWriteUpFields(row);
    const prompt = [docs(fields.vars), fields.note].join('\n\n');
    this.deps.store.writeUpObstacle(row.obstacle.id, { title: fields.title, prompt });
  }
}
