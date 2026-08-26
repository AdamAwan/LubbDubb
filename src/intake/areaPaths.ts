import type { ErrorRecorder } from '../errorLog.js';
import type { AreaPathTree } from './placement.js';

/**
 * Where the project's area tree is read from — a structural seam over the
 * composite connector, so the directory can be driven in a test without a
 * provider.
 *
 * Null is "no tracker here has a classification tree", which is a configuration
 * and not a failure — see `CompositeConnector.listAreaPaths`.
 */
interface AreaPathSource {
  listAreaPaths(): Promise<AreaPathTree | null>;
}

/** How long a reading of the area tree is treated as current. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * The project's area tree, held so it can be read **synchronously**.
 *
 * ## Why it is cached at all
 *
 * Two callers need it and neither can await: `appraise_issue` builds its argument
 * schema when an agent's tool set is composed, and the state snapshot decides
 * whether a work item is still unclassified while composing a response. Both want
 * a list that changes at the speed a team reorganises its board — so paying an
 * HTTP round trip per tool build, or per snapshot, would buy nothing at all.
 *
 * ## Why it fails soft
 *
 * A read that fails leaves the **last good tree standing** rather than emptying
 * it, and records the failure. Emptying instead would be the silent direction
 * twice over: the appraiser would stop being offered any area (its argument
 * disappears from the schema, which reads as "this deployment has no areas"), and
 * every item would read as classified, since `isPlacementMissing` cannot compare
 * against a root it does not have. Neither is red, and both look exactly like the
 * feature being off.
 *
 * Until the first successful read the tree is null, which is the same reading a
 * tracker with no tree gives — and the right one: nothing has been offered, so
 * nothing is asked.
 */
export class AreaPathDirectory {
  private tree: AreaPathTree | null = null;
  private fetchedAt = 0;
  /** In-flight read, so a pulse that overlaps the last one does not start a second. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly source: AreaPathSource,
    private readonly opts: { now: () => number; ttlMs?: number; errors?: ErrorRecorder } = { now: Date.now },
  ) {}

  /**
   * The last good reading, or null while there is none.
   *
   * Deliberately never triggers a read: a getter that fetched would make the two
   * synchronous callers above asynchronous, which is the whole thing this class
   * exists to avoid.
   *
   * @public read through `AreaPathReader` by the MCP tool layer and the state
   * snapshot, which are handed a thunk rather than this object.
   */
  current(): AreaPathTree | null {
    return this.tree;
  }

  /**
   * Bring the tree up to date if it is stale, and do nothing if it is not.
   *
   * Called from the pulse, so the cadence is the harness's heartbeat filtered
   * through the TTL rather than a timer of its own — a timer would keep firing
   * across a drain and an upgrade handoff, which is the class of thing
   * `main.ts`'s shutdown ordering exists to keep out of the process.
   */
  async refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const ttl = this.opts.ttlMs ?? DEFAULT_TTL_MS;
    if (this.tree !== null && this.opts.now() - this.fetchedAt < ttl) return;
    this.inFlight = this.read();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async read(): Promise<void> {
    try {
      const tree = await this.source.listAreaPaths();
      // A provider with no tree is a settled answer, so the clock is stamped for
      // it too — otherwise every pulse on GitHub would re-ask a question whose
      // answer is structural.
      this.tree = tree;
      this.fetchedAt = this.opts.now();
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `Failed to read the project's area paths: ${(err as Error).message}`,
      });
    }
  }
}
