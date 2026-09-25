import type { DecisionChoice } from '../insights/choiceInsights.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { WorldScope } from '../integrations/registry.js';
import type { Store } from '../store/store.js';
import type { PoolClockDocument, PoolClockKind } from '../types.js';
import { buildDigestDocument } from './digestArm.js';
import { parsePoolDocument, poolContentHash, poolStaleBefore } from './document.js';
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
      worldScope: WorldScope;
      choicesOff?: readonly DecisionChoice[];
      errors?: ErrorRecorder;
    },
  ) {}

  async run(): Promise<void> {
    const boot = this.firstPass;
    this.firstPass = false;
    if (this.deps.transport.canRead) await this.poll();
    await this.publishKind('digest', boot);
  }

  status(): PoolStatus {
    return {
      transportId: this.deps.transport.id,
      fleetId: this.deps.fleetId,
      project: this.deps.project,
      canRead: this.deps.transport.canRead,
      polledAt: this.polledAt,
      digest: this.deps.store.pool.getPublication('digest'),
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
    const staleBefore = poolStaleBefore(now);
    for (const entry of fetched) {
      const parsed = parsePoolDocument(entry.text, entry.addressedTo ?? undefined);
      if (!parsed.ok) {
        if (parsed.reason === 'ahead') {
          if (parsed.fleetId !== null) {
            this.deps.store.pool.recordFleetReading({
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
      this.land(parsed.document, staleBefore);
    }
    this.expire();
    this.polledAt = now;
  }

  private land(document: PoolClockDocument, staleBefore: string): void {
    try {
      if (document.fleetId === this.deps.fleetId) {
        this.deps.store.pool.recordOwnFleetReading(document.fleetId, document.project);
        return;
      }
      if (document.publishedAt >= staleBefore) {
        this.deps.store.pool.replaceFleetDigest(document.fleetId, document.project, document);
      }
      this.deps.store.pool.recordFleetReading({
        fleetId: document.fleetId,
        project: document.project,
        digestAt: document.publishedAt,
        ahead: false,
      });
    } catch (error) {
      this.record(`Could not land ${document.fleetId}'s ${document.kind} document`, error);
    }
  }

  private expire(): void {
    try {
      this.deps.store.pool.expireStaleDigests();
    } catch (error) {
      this.record('Could not expire the stale fleets in the pool mirror', error);
    }
  }

  private async publishKind(kind: PoolClockKind, boot: boolean): Promise<void> {
    const publication = this.deps.store.pool.getPublication(kind);
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
      this.deps.store.pool.recordPoolChecked(kind);
      return;
    }
    try {
      await this.deps.transport.publish(document);
      this.deps.store.pool.recordPoolPublish(kind, hash);
    } catch (error) {
      this.deps.store.pool.markPoolDirty(kind);
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
      choicesOff: this.deps.choicesOff,
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
