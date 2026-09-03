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

/** How a note's documentation prompt is rendered — the operator's house style, not the harness's. */
type DocsPrompt = (vars: Record<string, string>) => string;

/**
 * The desk that ends an obstacle: the four endings, run in the order they can
 * settle a row.
 *
 * **It runs only on a real world reading**, and that is the one rule here worth
 * stating twice. A resolution fires on **two consecutive real readings**, and the
 * resolving read is never one the local cycle served: a local cycle re-serves the
 * snapshot the last real one read, so a desk that counted it would take one reading
 * twice and call an obstacle over on the strength of a world nobody had looked at
 * since. A resolution on a stale reading closes an obstacle that is still live, the
 * fleet pays for it again, and nothing is red. The second half of that promise is
 * the condition rows' own `met_at`: a reading that finds a condition unmet clears
 * the stamp, so "consecutive" is a fact about the column rather than an intention
 * here.
 *
 * On the pulse and not in `src/dispatcher/` for the notice desk's reason: it staffs
 * nobody itself and no rule reads what it writes. The one thing it queues is a
 * note's documentation job, which is an ordinary job the dispatcher ranks and the
 * cap bounds like any other — and it is bounded once more on top of that, to one in
 * flight, because the cut bounds how many agents run and not how many of them this
 * subsystem may be. → `docs/spec/32-obstacles.md#how-an-obstacle-ends`
 */
export class ObstacleEndingsDesk {
  /**
   * One pass at a time, the ownership desk's reason: the sweep below assumes an
   * open write-up belongs to a pass that has ended, which a second pass overlapping
   * the first would make false.
   */
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      /** No report for this long and no owner → `dormant`. `config.obstacleDormantMs`. */
      dormantMs: number;
      /**
       * How a note's write-up prompt is rendered. Absent = no note is ever written
       * up, and then a note ends only by decaying — which is a deployment with no
       * prompt book rather than a policy.
       */
      docsPrompt?: DocsPrompt;
      /** Injectable so the clock arms are testable without waiting a week. */
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
      // The conditions first, so a check that has gone red since the last pulse is
      // watched from this one. Writing them is idempotent — the UNIQUE means a
      // still-red check re-promises nothing.
      for (const condition of conditionsToWatch(board, world.pullRequests))
        this.deps.store.watchObstacleCondition(condition);
      this.settleConditions(board, world);
      this.settleLandings(board);
      this.expire(board, now);
      this.decay(board, now);
      this.sweepWriteUps();
      this.writeUpNotes();
    } catch (err) {
      // Never into the cycle, the two desks beside it: a pass that could fail a
      // pulse is a pass an operator turns off, and then nothing ever ends.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Ending obstacles failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * The world's own answer: every condition on a row met, on two consecutive real
   * readings.
   *
   * The stamps are written for **every** row with conditions, including ones this
   * pass will not resolve — that is what makes the second reading consecutive with
   * the first rather than merely later than it.
   */
  private settleConditions(board: readonly ObstacleStanding[], world: WorldSnapshot): void {
    for (const row of board) {
      const conditions = this.deps.store.listObstacleConditions(row.obstacle.id);
      if (conditions.length === 0) continue;
      // Read before the stamps move, so this pass's verdict is *this* reading's and
      // the row it resolves is one a previous reading already agreed about.
      const settledBefore = conditions.every((condition) => condition.metAt !== null);
      for (const condition of conditions)
        this.deps.store.setObstacleConditionMet(condition.id, conditionMet(condition, world.pullRequests));
      if (settledBefore && conditionsSettled(conditions, world.pullRequests))
        this.deps.store.endObstacle(row.obstacle.id, 'resolved', 'condition');
    }
  }

  /**
   * The owner's work shipping, off the landing sweep rather than off the merge.
   *
   * One read of the landings for the whole board: the sweep has already attributed
   * every merge it can see, and asking it per row would be the same list read once
   * per obstacle.
   */
  private settleLandings(board: readonly ObstacleStanding[]): void {
    const owned = board.filter((row) => row.obstacle.state === 'owned' && row.obstacle.ownerRef !== null);
    if (owned.length === 0) return;
    const landings = this.deps.store.listGoalLandings();
    for (const row of owned)
      if (ownerLanded(row.obstacle, landings)) this.deps.store.endObstacle(row.obstacle.id, 'resolved', 'landing');
  }

  /** The reporter's own clock, on a row no condition and no owner settled. */
  private expire(board: readonly ObstacleStanding[], now: number): void {
    for (const row of board)
      if (clockExpired(row.obstacle, now)) this.deps.store.endObstacle(row.obstacle.id, 'resolved', 'expiry');
  }

  /** Nothing has said it for `obstacleDormantMs`, and nothing owns it. */
  private decay(board: readonly ObstacleStanding[], now: number): void {
    for (const row of board)
      if (decayed(row.obstacle, now, this.deps.dormantMs))
        this.deps.store.endObstacle(row.obstacle.id, 'dormant', 'decay');
  }

  /**
   * What became of each note's documentation change — and, for the ones that
   * landed, the note leaving every prompt because the repository now says it.
   *
   * Read from the **work graph**, which is upsert-only and remembers a merge long
   * after `closedPullRequests` has forgotten it: a write-up that merged during a
   * restart is settled by the first pulse after it rather than lost.
   */
  private sweepWriteUps(): void {
    const open = this.deps.store.openObstacleWriteUps();
    if (open.length === 0) return;
    for (const writeUp of open) {
      const nodes = this.deps.store.listWorkSubtree(`job:${writeUp.jobId}`);
      const pr = nodes.find((node) => node.kind === 'pr');
      if (pr && writeUp.prRef === null) this.deps.store.noteObstacleWriteUpPr(writeUp.obstacleId, pr.ref);
      const reading = writeUpReading(writeUp.jobId, nodes);
      // `unknown` and *still going* both settle nothing. A pull request the graph
      // marks merged by inference vanished without ever being seen closed, and
      // acting on it would take a note out of every prompt for a change that may
      // never have landed.
      if (reading !== 'landed' && reading !== 'abandoned') continue;
      if (!this.deps.store.settleObstacleWriteUp(writeUp.obstacleId, reading)) continue;
      // Only a landing ends the note. An abandoned write-up leaves it standing, to
      // decay like anything else — the fleet is still being told something true.
      if (reading === 'landed') this.deps.store.endObstacle(writeUp.obstacleId, 'resolved', 'written-down');
    }
  }

  /**
   * Queue one note's documentation change.
   *
   * **One in flight across the whole fleet**, which is rule `obstacle-repair`'s
   * bound and taken for its reason: a board that went to twenty standing notes on a
   * bad afternoon would otherwise queue twenty jobs, and the subsystem whose point
   * is not spending the fleet twice on one thing would be spending it on itself.
   * The rest are still standing next pulse, and nothing is lost.
   */
  private writeUpNotes(): void {
    const docs = this.deps.docsPrompt;
    if (!docs) return;
    if (this.deps.store.openObstacleWriteUps().length > 0) return;
    const row = notesToWriteUp(this.deps.store.obstacleBoard(), this.deps.store.obstaclesWrittenUp())[0];
    if (!row) return;
    const fields = noteWriteUpFields(row);
    // Appended, never interpolated: `loadPromptTemplates` rejects only *unknown*
    // placeholders, so an override written before this existed would silently drop
    // a new `{token}` — on exactly the deployments that customised most.
    const prompt = [docs(fields.vars), fields.note].join('\n\n');
    this.deps.store.writeUpObstacle(row.obstacle.id, { title: fields.title, prompt });
  }
}
