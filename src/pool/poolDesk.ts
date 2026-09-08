import type { ErrorRecorder } from '../errorLog.js';
import type { WorldScope } from '../integrations/registry.js';
import { packSecretRefusal } from '../reviewPacks/secrets.js';
import type { Store } from '../store/store.js';
import type { PoolClockDocument, PoolClockKind, PoolPackDocument, ReviewPackShare } from '../types.js';
import { buildDigestDocument } from './digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument, poolContentHash } from './document.js';
import type { PoolTransport } from './transport.js';

// → docs/spec/28-cross-fleet-pool.md

export class PoolDesk {
  private polledAt: string | null = null;

  private firstPass = true;

  constructor(
    private readonly deps: {
      store: Store;
      transport: PoolTransport;
      fleetId: string;
      project: string;
      harnessVersion: string;
      now: () => string;
      digestIntervalMs: number;
      closedPrWindowMs: number;
      worldScope: WorldScope;
      errors?: ErrorRecorder;
    },
  ) {}

  async run(): Promise<void> {
    const boot = this.firstPass;
    this.firstPass = false;
    if (this.deps.transport.canRead) await this.poll();
    await this.publishKind('digest', boot);
    await this.carryPacks();
  }

  private async carryPacks(): Promise<void> {
    for (const share of this.deps.store.listReviewPackShares()) {
      if (share.withdrawnAt !== null || this.dead(share)) {
        await this.prune(share);
        continue;
      }
      if (share.publishedAt !== null || share.refusal !== null) continue;
      await this.publishPack(share);
    }
  }

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
      this.record(`Could not publish the review pack for #${share.prNumber} to the pool`, error);
    }
  }

  private async prune(share: ReviewPackShare): Promise<void> {
    if (share.publishedAt === null) {
      this.deps.store.deleteReviewPackShare(share.prNumber);
      return;
    }
    try {
      await this.deps.transport.unpublish({ fleetId: this.deps.fleetId, prNumber: share.prNumber });
      this.deps.store.deleteReviewPackShare(share.prNumber);
    } catch (error) {
      this.record(`Could not prune the shared review pack for #${share.prNumber}`, error);
    }
  }

  private dead(share: ReviewPackShare): boolean {
    const world = this.deps.store.getWorldBaseline();
    if (!world) return false;
    if (world.pullRequests.some((pr) => pr.number === share.prNumber)) return false;
    const closed = world.closedPullRequests?.find((pr) => pr.number === share.prNumber);
    if (!closed) return true;
    if (!closed.closedAt) return false;
    return new Date(this.deps.now()).getTime() - new Date(closed.closedAt).getTime() >= this.deps.closedPrWindowMs;
  }

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

  private async publishKind(kind: PoolClockKind, boot: boolean): Promise<void> {
    const publication = this.deps.store.getPoolPublication(kind);
    const now = this.deps.now();
    const slowClockDue =
      boot ||
      publication.checkedAt === null ||
      new Date(now).getTime() - new Date(publication.checkedAt).getTime() >= this.deps.digestIntervalMs;
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
      this.deps.store.recordPoolChecked(kind);
      return;
    }
    try {
      await this.deps.transport.publish(document);
      this.deps.store.recordPoolPublish(kind, hash);
    } catch (error) {
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
      scope: this.deps.worldScope,
    };
    return buildDigestDocument(this.deps.store, context);
  }

  private record(message: string, error: unknown): void {
    this.deps.errors?.record({
      source: 'cycle',
      message,
      detail: error === null ? undefined : error instanceof Error ? error.message : String(error),
    });
  }
}

export interface PoolStatus {
  transportId: string;
  fleetId: string;
  project: string;
  canRead: boolean;
  polledAt: string | null;
  digest: import('../types.js').PoolPublication;
}
