import type { ErrorRecorder } from '../errorLog.js';
import { packSecretRefusal } from '../reviewPacks/secrets.js';
import type { Store } from '../store/store.js';
import type { PoolClockDocument, PoolClockKind, PoolPackDocument, ReviewPackShare } from '../types.js';
import { buildDigestDocument } from './digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument, poolContentHash } from './document.js';
import type { PoolTransport } from './transport.js';

/**
 * One desk in the pulse, and **the pulse is the clock** — never a `setInterval`,
 * which keeps firing through a pause, shutdown and the upgrade handoff. The dirty
 * flag is a hint and the content hash is the truth; the publish is never inside a
 * route handler; every failure is caught, recorded and non-fatal, and there is no
 * backoff because retry is the next pulse.
 * → `docs/spec/28-cross-fleet-pool.md#the-clocks`
 */
export class PoolDesk {
  /**
   * The last successful poll, or null while there has never been one. *Could not
   * reach the pool* is never folded into *nobody has published anything*.
   */
  private polledAt: string | null = null;

  private firstPass = true;

  constructor(
    private readonly deps: {
      store: Store;
      transport: PoolTransport;
      fleetId: string;
      project: string;
      harnessVersion: string;
      /** Injectable clock, so the hourly arms are testable without waiting an hour. */
      now: () => string;
      digestIntervalMs: number;
      /**
       * How long a closed pull request stays in the world the cockpit draws; a shared
       * pack is pruned on the first publish after that, so it outlives its row by nothing.
       * → `docs/spec/31-review-packs.md#sharing-a-pack`, `docs/spec/07-pull-requests.md`
       */
      closedPrWindowMs: number;
      errors?: ErrorRecorder;
    },
  ) {}

  /**
   * One pass. **Poll before publish**, so what goes out describes a store that has
   * already absorbed this pulse's arrivals; on boot the first pass polls and runs
   * the backstop rather than waiting out the hour.
   */
  async run(): Promise<void> {
    const boot = this.firstPass;
    this.firstPass = false;
    if (this.deps.transport.canRead) await this.poll();
    await this.publishKind('digest', boot);
    await this.carryPacks();
  }

  /**
   * The third document, and the one nothing here decides to publish: it carries out
   * the standing asks and prunes the dead ones, with no clock, flag or hash. Here
   * rather than in the route so a failed push cannot read as a share that failed
   * locally. → `docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`
   */
  private async carryPacks(): Promise<void> {
    for (const share of this.deps.store.listReviewPackShares()) {
      // Withdrawn first, and before the death check: one removal path, so a
      // withdrawal cannot take a route a prune has never taken.
      if (share.withdrawnAt !== null || this.dead(share)) {
        await this.prune(share);
        continue;
      }
      // Published or refused: both settled. A refusal is never retried into a publish.
      if (share.publishedAt !== null || share.refusal !== null) continue;
      await this.publishPack(share);
    }
  }

  /**
   * One asked-for pack into the namespace. The secret backstop is run **again**
   * rather than trusted from the ask — this is the last thing between the pack and
   * a repository that never forgets. It refuses and never rewrites.
   */
  private async publishPack(share: ReviewPackShare): Promise<void> {
    const record = this.deps.store.getReviewPackAt(share.prNumber, share.headSha);
    if (record === null) {
      this.deps.store.recordReviewPackShareRefusal(
        share.prNumber,
        `the pack for #${share.prNumber} at ${share.headSha} is no longer in the store, so there was nothing to share`,
      );
      return;
    }
    const refusal = packSecretRefusal(record.pack);
    if (refusal !== null) {
      // Not an error-log entry: a refusal is this control working.
      this.deps.store.recordReviewPackShareRefusal(share.prNumber, refusal);
      return;
    }
    const document: PoolPackDocument = {
      pool: POOL_SCHEMA_VERSION,
      kind: 'pack',
      fleetId: this.deps.fleetId,
      project: this.deps.project,
      publishedAt: this.deps.now(),
      harnessVersion: this.deps.harnessVersion,
      prNumber: share.prNumber,
      headSha: record.pack.headSha,
      writtenAt: record.writtenAt,
      pack: record.pack,
    };
    try {
      await this.deps.transport.publish(document);
      this.deps.store.recordReviewPackShared(share.prNumber);
    } catch (error) {
      // Left unpublished deliberately: the put is a whole replace, so the next pulse retries.
      this.record(`Could not publish the review pack for #${share.prNumber} to the pool`, error);
    }
  }

  /**
   * Take a shared pack out of the namespace — its pull request closed long enough
   * ago, or somebody unshared it. **The local `review_packs` row is kept**; what
   * goes is the copy in the shared substrate and the share row describing it.
   */
  private async prune(share: ReviewPackShare): Promise<void> {
    if (share.publishedAt === null) {
      // Never landed, so there is nothing in the namespace to remove.
      this.deps.store.deleteReviewPackShare(share.prNumber);
      return;
    }
    try {
      await this.deps.transport.unpublish({ fleetId: this.deps.fleetId, prNumber: share.prNumber });
      this.deps.store.deleteReviewPackShare(share.prNumber);
    } catch (error) {
      // The row stays so the next pulse tries again: a pack left in the pool is what pruning prevents.
      this.record(`Could not prune the shared review pack for #${share.prNumber}`, error);
    }
  }

  /**
   * Whether a shared pack's pull request has been closed for `closedPrWindowMs`,
   * read off the world the cockpit draws. With no baseline nothing is pruned:
   * *the harness has not looked* is never *the pull request is long gone*.
   */
  private dead(share: ReviewPackShare): boolean {
    const world = this.deps.store.getWorldBaseline();
    if (!world) return false;
    if (world.pullRequests.some((pr) => pr.number === share.prNumber)) return false;
    const closed = world.closedPullRequests?.find((pr) => pr.number === share.prNumber);
    // Out of the closed window entirely: the row the cockpit drew is gone.
    if (!closed) return true;
    if (!closed.closedAt) return false;
    return new Date(this.deps.now()).getTime() - new Date(closed.closedAt).getTime() >= this.deps.closedPrWindowMs;
  }

  /**
   * A person asking for one pack to be shared: a second, deliberate act, never a
   * default. The backstop runs here synchronously so the caller is told which line
   * stopped it, and **no row is written for a refusal with a caller to tell**. The
   * publish itself is the next pulse's.
   */
  /**
   * The inverse: a person taking a shared pack back out. The ask is recorded at
   * once and the copy goes on the next pulse — the network write is never a route
   * handler's. Unsharing something nobody shared is answered as done, not an error.
   * → `docs/spec/31-review-packs.md#unsharing-a-pack`
   */
  unshareReviewPack(prNumber: number): { share: ReviewPackShare | null } {
    return { share: this.deps.store.withdrawReviewPackShare(prNumber) };
  }

  shareReviewPack(prNumber: number): { ok: true; share: ReviewPackShare } | { ok: false; status: 409; error: string } {
    const record = this.deps.store.getCurrentReviewPack(prNumber);
    if (record === null) {
      return { ok: false, status: 409, error: `there is no review pack for #${prNumber} to share` };
    }
    const refusal = packSecretRefusal(record.pack);
    if (refusal !== null) {
      return {
        ok: false,
        status: 409,
        error:
          `This pack was not shared: ${refusal}. Nothing was rewritten and nothing left the machine — ` +
          `fix the line in the change and ask for the pack again.`,
      };
    }
    return {
      ok: true,
      share: this.deps.store.recordReviewPackShare({ prNumber, headSha: record.pack.headSha }),
    };
  }

  /** What the cockpit draws about this fleet's own side of the pool. */
  status(): PoolStatus {
    return {
      transportId: this.deps.transport.id,
      fleetId: this.deps.fleetId,
      project: this.deps.project,
      canRead: this.deps.transport.canRead,
      polledAt: this.polledAt,
      digest: this.deps.store.getPoolPublication('digest'),
    };
  }

  /**
   * Pull everybody's documents and land them. A failed fetch leaves the
   * last-known-good mirror in place rather than emptying it, so an outage never
   * reads as "nobody else knows anything".
   * → `docs/spec/24-environments.md#the-three-verdicts`
   */
  private async poll(): Promise<void> {
    let fetched;
    try {
      fetched = await this.deps.transport.fetch();
    } catch (error) {
      this.record('Could not read the cross-fleet pool', error);
      return;
    }
    const now = this.deps.now();
    for (const entry of fetched) {
      const parsed = parsePoolDocument(entry.text, entry.addressedTo ?? undefined);
      if (!parsed.ok) {
        // Per document, always: one bad body must not take every other fleet's down with it.
        if (parsed.reason === 'ahead') {
          if (parsed.fleetId !== null) {
            this.deps.store.recordPoolFleetReading({
              fleetId: parsed.fleetId,
              project: null,
              digestAt: null,
              ahead: true,
            });
          }
          continue;
        }
        this.record(`Skipped a pool document: ${parsed.detail}`, null);
        continue;
      }
      this.land(parsed.document);
    }
    this.polledAt = now;
  }

  /**
   * One parsed document into the mirror. **This fleet's own document is read back
   * and never landed**: landing it folds this fleet's numbers into the aggregate as
   * another fleet's, and looks exactly like the pool working.
   * → `docs/spec/28-cross-fleet-pool.md`
   */
  private land(document: PoolClockDocument): void {
    try {
      if (document.fleetId === this.deps.fleetId) {
        this.deps.store.recordPoolFleetReading({
          fleetId: document.fleetId,
          project: document.project,
          digestAt: null,
          ahead: false,
        });
        return;
      }
      this.deps.store.replacePoolFleetDigest(document.fleetId, document.project, document);
      this.deps.store.recordPoolFleetReading({
        fleetId: document.fleetId,
        project: document.project,
        digestAt: document.publishedAt,
        ahead: false,
      });
    } catch (error) {
      this.record(`Could not land ${document.fleetId}'s ${document.kind} document`, error);
    }
  }

  /** Publish one document if it needs publishing: the clock makes it due, the hash decides what goes out. */
  private async publishKind(kind: PoolClockKind, boot: boolean): Promise<void> {
    const publication = this.deps.store.getPoolPublication(kind);
    const now = this.deps.now();
    const slowClockDue =
      boot ||
      publication.checkedAt === null ||
      new Date(now).getTime() - new Date(publication.checkedAt).getTime() >= this.deps.digestIntervalMs;
    // No fast path: the clock is the whole of what makes this due.
    if (!slowClockDue) return;

    let document: PoolClockDocument;
    try {
      document = this.derive(kind, now);
    } catch (error) {
      this.record(`Could not derive this fleet's ${kind} document`, error);
      return;
    }
    const hash = poolContentHash(document);
    if (hash === publication.contentHash) {
      // Nothing changed: stamp the check rather than push, so an idle fleet writes nothing.
      this.deps.store.recordPoolChecked(kind);
      return;
    }
    try {
      await this.deps.transport.publish(document);
      this.deps.store.recordPoolPublish(kind, hash);
    } catch (error) {
      // Left dirty deliberately: the put is a whole replace, so the next pulse retries.
      this.deps.store.markPoolDirty(kind);
      this.record(`Could not publish this fleet's ${kind} document to the pool`, error);
    }
  }

  private derive(kind: PoolClockKind, now: string): PoolClockDocument {
    const context = {
      fleetId: this.deps.fleetId,
      project: this.deps.project,
      harnessVersion: this.deps.harnessVersion,
      now,
    };
    return buildDigestDocument(this.deps.store, context);
  }

  /** One error record per failure, and no backoff: a failing pool needs to be visible, not rescheduled. */
  private record(message: string, error: unknown): void {
    this.deps.errors?.record({
      source: 'cycle',
      message,
      detail: error === null ? undefined : error instanceof Error ? error.message : String(error),
    });
  }
}

/** What the cockpit draws about this fleet's own side of the pool. */
export interface PoolStatus {
  transportId: string;
  fleetId: string;
  project: string;
  /** False on a publish-only substrate: this fleet contributes and consumes nothing. */
  canRead: boolean;
  /** The last successful poll, or null. Never folded into "nobody has published anything". */
  polledAt: string | null;
  digest: import('../types.js').PoolPublication;
}
