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

/** How the desk writes the ticket's body — the operator's house style, not the harness's. */
type TicketBody = (vars: Record<string, string>) => string;

/**
 * The desk that gives a standing obstacle an owner, and lets a blocked goal back
 * out.
 *
 * **Never an agent.** The claim is `Store.claimObstacle` — one `UPDATE … WHERE
 * state='standing' AND owner_ref IS NULL` — so *do not all pile on* is a
 * uniqueness constraint rather than an instruction, and two passes cannot both
 * take one row. Which door a row is at is {@link ownershipDoor}'s answer and never
 * a second opinion here; this reads it, claims, and files.
 *
 * Two doors, and only one of them is this desk's to walk through:
 *
 * - **The ticket** it files itself, through `ticketFiler` — the ticket then enters
 *   the normal funnel and is ranked and priced like any other goal.
 * - **The repair dispatch** belongs to rule `obstacle-repair`, which proposes it
 *   through the candidate list and takes the headroom cut like everything else.
 *   The desk only *records* it: once a task exists on `obstacle:<id>`, the row is
 *   claimed and the dispatch named as its owner. Owning it any earlier would be
 *   the board marking a row `owned` on the strength of a candidate that the cut
 *   may never have dispatched.
 *
 * On the pulse and not in `src/dispatcher/` for the notice desk's reason: it
 * staffs nobody itself and no rule reads what it writes — rule `obstacle-repair`
 * reads the **board**, which is the same board an agent's report writes.
 * → `docs/spec/32-obstacles.md#ownership`
 */
export class ObstacleOwnershipDesk {
  /**
   * One pass at a time. A filing is a round trip to a provider, and the release
   * sweep below assumes an `owned` row with no owner belongs to a pass that has
   * ended — which a second pass overlapping the first would make false, and it
   * would release a row mid-filing.
   */
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      /** Absent where the deployment has no tracker configured: then no ticket is ever filed. */
      filing?: TicketFiler;
      /** How a ticket's body is written. Absent = the claim and the sightings, unstyled. */
      ticketBody?: TicketBody;
      /** The effective watch label, or `''` with the gate off. Empty is never written. */
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
      // Never into the cycle, the notice desk's rule: a pass that could fail a
      // pulse is a pass an operator turns off, and then nothing owns anything.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Taking ownership of obstacles failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Let every goal whose obstacle stopped reaching agents back into pickup.
   *
   * Clearing the row is the whole act: pickup's gate reads the blocks, so a goal
   * with none is a goal the funnel sees exactly as it did before it was blocked.
   * Nothing is written onto the issue — a conclusion written from here would clear
   * the goal's delivery row if one had landed meanwhile, which is delivered work
   * handed back to the fleet.
   */
  private releaseGoals(): void {
    const blocks = this.deps.store.listObstacleBlocks();
    if (blocks.length === 0) return;
    for (const block of releasedBlocks(blocks, this.deps.store.obstacleBoard()))
      this.deps.store.clearObstacleBlock(block.originRef);
  }

  /**
   * Hand back a row claimed by a pass that never named an owner.
   *
   * The claim is taken *before* the filing, so a crash — or a tracker that never
   * answered — leaves an `owned` row with a null owner: told to the fleet as
   * *something is fixing it* with nothing fixing it, and no exit. Released at the
   * top of the next pass, which is safe because {@link running} means no filing of
   * this desk's is in flight.
   */
  private recoverStaleClaims(board: readonly ObstacleStanding[]): void {
    for (const row of board)
      if (row.obstacle.state === 'owned' && row.obstacle.ownerRef === null)
        this.deps.store.releaseObstacle(row.obstacle.id);
  }

  /**
   * Record the repair dispatches that actually happened.
   *
   * A live task on `obstacle:<id>` is the fleet having spent a slot on the row, so
   * that is the moment it is owned — and the owner is the dispatch's own origin,
   * which is what the intake and the prompts then name. Claimed transactionally
   * like every other, so a pulse that races a re-dispatch cannot own it twice.
   */
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

  /**
   * File one ticket per standing obstacle at the ticket door.
   *
   * **One per pass**, because each is a round trip to the tracker and a pulse that
   * filed twenty would be a pulse that stalled; the rest are still standing next
   * time, and nothing is lost. A filing that fails hands the row back, so the next
   * pass tries again rather than leaving it owned by nothing.
   */
  private async fileTickets(board: readonly ObstacleStanding[], red: ReadonlySet<string>): Promise<void> {
    const filing = this.deps.filing;
    if (!filing) return;
    const row = board.find((candidate) => ownershipDoor(candidate, red) === 'ticket');
    if (!row) return;
    if (!this.deps.store.claimObstacle(row.obstacle.id)) return;
    const sightings = this.deps.store.listObstacleSightings(row.obstacle.id);
    const fields = obstacleTicketFields(row, sightings);
    // What the model desk wrote from the sightings, where it has read this row.
    // **Writing the ticket is a job a model may do** — it is prose, read by
    // whoever reads any other ticket, and a wrong one is a ticket rather than a
    // silence. It replaces the mechanical composition rather than being appended
    // to it, so the ticket says one thing once; a deployment with no reader wired
    // gets the composition and the operator's own `obstacle-ticket-body` template
    // exactly as before.
    // → `docs/spec/32-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not`
    const written = this.deps.store.obstacleReading(row.obstacle.id);
    try {
      const ref = await filing({
        title: written?.title ?? fields.title,
        body: written?.body ?? (this.deps.ticketBody ? this.deps.ticketBody(fields.vars) : plainBody(fields.vars)),
        // Empty with the watch gate off (`labelPrefix: ''`), and an empty label
        // must never be written — the harness then acts on every open issue and
        // there is nothing to tag. Never a sentence in a prompt either way: a
        // ticket without this label is created, linked, shown complete, and never
        // dispatched for.
        labels: this.deps.watchLabel ? [this.deps.watchLabel] : [],
        // Something broken now, which a fix ends — which is the whole of what an
        // obstacle is, and what the tracker's bug type means.
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

/** The ticket a deployment with no override gets: the claim, the keys, the voices. */
function plainBody(vars: Record<string, string>): string {
  return (
    `${vars.claim}\n\n` +
    `The fleet has hit this ${vars.voices} times. It identifies as: ${vars.keys}.\n\n` +
    `Goals that hit it: ${vars.goals}\n\n` +
    `## What the agents said\n\n${vars.sightings}\n`
  );
}
