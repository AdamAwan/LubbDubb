import type { ErrorRecorder } from '../errorLog.js';
import type { AreaPathTree } from './placement.js';

// → docs/spec/06-issue-pickup.md

interface AreaPathSource {
  listAreaPaths(): Promise<AreaPathTree | null>;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class AreaPathDirectory {
  private tree: AreaPathTree | null = null;
  private fetchedAt = 0;
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
