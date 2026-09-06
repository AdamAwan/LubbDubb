import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { ObstacleStanding, WorldSnapshot } from '../types.js';
import { releasedBlocks } from './blocked.js';
import {
  obstacleRepairOrigin,
  obstacleTicketFields,
  obstacleTicketGoal,
  ownershipDoor,
  redBaseChecks,
} from './ownership.js';

// → docs/spec/27-obstacles.md

type TicketBody = (vars: Record<string, string>) => string;

export class ObstacleOwnershipDesk {
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      filing?: TicketFiler;
      ticketBody?: TicketBody;
      watchLabel: string;
      errors?: ErrorRecorder;
    },
  ) {}

  async run(world: WorldSnapshot): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.releaseGoals();
      const board = this.deps.store.obstacleBoard();
      this.recoverStaleClaims(board);
      this.recordRepairs(board);
      await this.fileTickets(board, redBaseChecks(world.pullRequests));
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Taking ownership of obstacles failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  private releaseGoals(): void {
    const blocks = this.deps.store.listObstacleBlocks();
    if (blocks.length === 0) return;
    for (const block of releasedBlocks(blocks, this.deps.store.obstacleBoard()))
      this.deps.store.clearObstacleBlock(block.originRef);
  }

  private recoverStaleClaims(board: readonly ObstacleStanding[]): void {
    for (const row of board)
      if (row.obstacle.state === 'owned' && row.obstacle.ownerRef === null)
        this.deps.store.releaseObstacle(row.obstacle.id);
  }

  private recordRepairs(board: readonly ObstacleStanding[]): void {
    const live = new Set(
      this.deps.store
        .listTasks()
        .filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'waiting')
        .map((task) => task.originRef ?? ''),
    );
    for (const row of board) {
      if (row.obstacle.state !== 'standing' || row.obstacle.ownerRef !== null) continue;
      const origin = obstacleRepairOrigin(row.obstacle.id);
      if (!live.has(origin)) continue;
      if (this.deps.store.claimObstacle(row.obstacle.id)) this.deps.store.setObstacleOwner(row.obstacle.id, origin);
    }
  }

  private async fileTickets(board: readonly ObstacleStanding[], red: ReadonlySet<string>): Promise<void> {
    const filing = this.deps.filing;
    if (!filing) return;
    const row = board.find((candidate) => ownershipDoor(candidate, red) === 'ticket');
    if (!row) return;
    if (!this.deps.store.claimObstacle(row.obstacle.id)) return;
    const sightings = this.deps.store.listObstacleSightings(row.obstacle.id);
    const fields = obstacleTicketFields(row, sightings);
    const written = this.deps.store.obstacleReading(row.obstacle.id);
    try {
      const ref = await filing({
        title: written?.title ?? fields.title,
        body: written?.body ?? (this.deps.ticketBody ? this.deps.ticketBody(fields.vars) : plainBody(fields.vars)),
        labels: this.deps.watchLabel ? [this.deps.watchLabel] : [],
        bug: true,
        relatedTo: obstacleTicketGoal(row) ?? undefined,
      });
      this.deps.store.setObstacleOwner(row.obstacle.id, ref);
    } catch (err) {
      this.deps.store.releaseObstacle(row.obstacle.id);
      this.deps.errors?.record({
        source: 'provider',
        message: `Filing a ticket for obstacle ${row.obstacle.id} failed: ${(err as Error).message}`,
      });
    }
  }
}

function plainBody(vars: Record<string, string>): string {
  return (
    `${vars.claim}\n\n` +
    `The fleet has hit this ${vars.voices} times. It identifies as: ${vars.keys}.\n\n` +
    `Goals that hit it: ${vars.goals}\n\n` +
    `## What the agents said\n\n${vars.sightings}\n`
  );
}
