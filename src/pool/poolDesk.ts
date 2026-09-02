import type { ErrorRecorder } from '../errorLog.js';
import { packSecretRefusal } from '../reviewPacks/secrets.js';
import type { Store } from '../store/store.js';
import type {
  PoolClockDocument,
  PoolClockKind,
  PoolMirroredClaim,
  PoolPackDocument,
  ReviewPackShare,
} from '../types.js';
import { buildClaimsDocument, importClaims, type PoolRefusal } from './claimsArm.js';
import { buildDigestDocument } from './digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument, poolContentHash } from './document.js';
import type { PoolTransport } from './transport.js';

/**
 * One desk in the pulse, and **the pulse is the clock**.
 *
 * Not a timer of its own: a `setInterval` keeps firing during a pause, during
 * shutdown and during the upgrade handoff, which is the class of failure
 * `docs/spec/21-self-update.md#where-the-shutdown-handlers-are-registered` is written
 * about.
 *
 * |                | Attempts when         | At the default cadence (30s busy, 5m idle)|
 * | -------------- | --------------------- | ----------------------------------------- |
 * | Claims publish | the document is dirty | the next pulse                            |
 * | Claims poll    | every pulse           | the same                                  |
 * | Digest publish | an hour since the last| the next pulse after the hour             |
 * | Backstop       | an hour since the last| re-derives **both** documents and compares|
 * | Packs          | a share is standing   | the next pulse; and prunes the dead ones  |
 *
 * **The dirty flag is a hint. The content hash is the truth.** An operator's ruling
 * marks the claims document dirty and the next pulse publishes it — the fast path,
 * and an optimisation rather than a correctness requirement, since a flag can be
 * lost to a crash between the ruling and the pulse. So on the slow clock the desk
 * re-derives both documents and compares their hash to what is published: different,
 * publish; same, do nothing. Anything the flag misses self-heals within the hour,
 * and the same comparison is what makes an hourly cadence cheap — an idle fleet
 * computes a hash and writes nothing.
 *
 * **The publish is never inside a route handler.** A route that did the network
 * write would make an operator's click wait on a push to another continent, and a
 * failed push there is a 500 on a ruling that *succeeded locally* — the operator
 * told their decision failed when the store took it. The store write is the truth
 * and the publish is a consequence.
 *
 * **Every failure is caught, recorded through `errors.record` and non-fatal.** A
 * publish that fails leaves the document dirty, so the next pulse retries. A fetch
 * that fails leaves the last-known-good mirror in place rather than emptying it.
 * Nothing about the harness stops: no dispatch is held, no agent waits, no boot
 * fails. And **there is no backoff** — retry is the next pulse, which is already a
 * five-minute floor, and exponential backoff on top would mostly mean a recovered
 * pool taking an hour to be noticed.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-clocks`
 */
export class PoolDesk {
  /**
   * The refusals from the last derivation, for the Knowledge page.
   *
   * In memory rather than a table: it is a property of the *current* store contents
   * re-derived on every pass, so a row would be a second copy of something already
   * derivable — the mirror's own argument, one arm over.
   */
  private refusals: PoolRefusal[] = [];

  /**
   * The last successful poll, or null while there has never been one.
   *
   * What the page's "the reading is stale and this old" is drawn from. *Could not
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
       * How long a closed pull request stays in the world the cockpit draws. A
       * shared pack is pruned on the first publish after its pull request has been
       * closed that long, so it outlives its pull request's row by nothing.
       * → `docs/spec/31-review-packs.md#sharing-a-pack`, `docs/spec/07-pull-requests.md`
       */
      closedPrWindowMs: number;
      errors?: ErrorRecorder;
    },
  ) {}

  /**
   * One pass.
   *
   * Poll first, then publish. The order is not arbitrary: an arrival that
   * corroborates a local claim can carry it to `lookup`, and a claim that reached
   * `lookup` this pass is not publishable anyway (it has no ruling yet) — so
   * polling first costs nothing and means the digest and claims published this pass
   * describe a store that has already absorbed the pulse's arrivals.
   *
   * **On boot the first pass polls and runs the backstop** rather than waiting an
   * hour: a deployment may have been off for a week, and claims vouched while the
   * pool was unreachable go out immediately rather than sixty minutes later.
   */
  async run(): Promise<void> {
    const boot = this.firstPass;
    this.firstPass = false;
    if (this.deps.transport.canRead) await this.poll();
    await this.publishKind('claims', boot);
    await this.publishKind('digest', boot);
    await this.carryPacks();
  }

  /**
   * The third document, and the one nothing here decides to publish.
   *
   * A pack leaves because a person asked for that pack to be shared, so this arm
   * has no clock, no dirty flag and no hash: it carries out the asks that are
   * standing, and prunes the ones whose pull request has been closed long enough.
   * It runs here rather than in the route for
   * `docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`'s
   * reason — a failed push must not read as a share that failed locally — and a
   * publish that throws leaves the row unpublished, so the next pulse retries it
   * exactly as a dirty document is retried.
   */
  private async carryPacks(): Promise<void> {
    for (const share of this.deps.store.listReviewPackShares()) {
      if (this.dead(share)) {
        await this.prune(share);
        continue;
      }
      // Published already, or refused: both are settled states, and a refusal is
      // never retried into a publish — the pack has to be written again.
      if (share.publishedAt !== null || share.refusal !== null) continue;
      await this.publishPack(share);
    }
  }

  /**
   * One asked-for pack into the namespace, with the backstop run over it again
   * first.
   *
   * Run **again** rather than trusted from the ask: the refusal the route gave is
   * about the document as it stood then, and this is the last thing between the
   * pack and a repository that never forgets. It refuses and never rewrites, and
   * the refusal names the line.
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
      // Not an error-log entry: a refusal is this control working, and the row is
      // where the person who asked reads it.
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
      // Left unpublished deliberately: the put is a whole replace, so the next
      // pulse re-derives and retries, and there is nothing to queue or replay.
      this.record(`Could not publish the review pack for #${share.prNumber} to the pool`, error);
    }
  }

  /**
   * Take a shared pack out of the namespace. **The local row is kept** — it is the
   * fleet's own record, and the cost of keeping it is the fleet's; what goes is
   * the copy in a substrate everybody clones, and the share row that described it.
   */
  private async prune(share: ReviewPackShare): Promise<void> {
    if (share.publishedAt === null) {
      // Never landed, so there is nothing in the namespace to remove and no reason
      // to make a commit saying so.
      this.deps.store.deleteReviewPackShare(share.prNumber);
      return;
    }
    try {
      await this.deps.transport.unpublish({ fleetId: this.deps.fleetId, prNumber: share.prNumber });
      this.deps.store.deleteReviewPackShare(share.prNumber);
    } catch (error) {
      // The row stays, so the next pulse tries again: a pack left in the pool
      // because one push failed is the thing pruning exists to prevent.
      this.record(`Could not prune the shared review pack for #${share.prNumber}`, error);
    }
  }

  /**
   * Whether a shared pack's pull request has been closed for `closedPrWindowMs` —
   * read off the same world the cockpit draws, and never off a silence. With no
   * baseline at all nothing is pruned: *the harness has not looked* must not be
   * folded into *the pull request is long gone*.
   */
  private dead(share: ReviewPackShare): boolean {
    const world = this.deps.store.getWorldBaseline();
    if (!world) return false;
    if (world.pullRequests.some((pr) => pr.number === share.prNumber)) return false;
    const closed = world.closedPullRequests?.find((pr) => pr.number === share.prNumber);
    // Out of the closed window entirely: the row the cockpit drew is gone, which is
    // the clock this is the same side of.
    if (!closed) return true;
    if (!closed.closedAt) return false;
    return new Date(this.deps.now()).getTime() - new Date(closed.closedAt).getTime() >= this.deps.closedPrWindowMs;
  }

  /**
   * A person asking for one pack to be shared. **Never by default and never on
   * the ask for a pack**: this is a second, deliberate act, and it is the only
   * thing that puts a pack in the namespace.
   *
   * The backstop runs here, synchronously, so the person who clicked is told which
   * line stopped it rather than watching a share that silently never happens —
   * and **no row is written for a refusal with a caller to tell**, because a row
   * would leave a "refused" state nothing clears. The refusal the arm records
   * later is the one nobody is there to hear.
   *
   * The publish itself is not here: it is the next pulse's, for
   * `docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`'s
   * reason.
   */
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
      claims: this.deps.store.getPoolPublication('claims'),
      digest: this.deps.store.getPoolPublication('digest'),
      refusals: this.refusals,
    };
  }

  /**
   * Pull everybody's documents and land them.
   *
   * A failed fetch leaves the last-known-good mirror in place rather than emptying
   * it, and the page says the reading is stale and how old it is — read as absence,
   * an outage would say in the operator's words that nobody else knows anything.
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
        // Per document, always. A version inside the body would fail the whole fetch
        // and take every other fleet's contribution down with it.
        if (parsed.reason === 'ahead') {
          if (parsed.fleetId !== null) {
            this.deps.store.recordPoolFleetReading({
              fleetId: parsed.fleetId,
              project: null,
              claimsAt: null,
              digestAt: null,
              ahead: true,
            });
          }
          continue;
        }
        this.record(`Skipped a pool document: ${parsed.detail}`, null);
        continue;
      }
      this.land(parsed.document, now);
    }
    this.polledAt = now;
  }

  /**
   * One parsed document into the mirror, and — for claims — into the knowledge base.
   *
   * **This fleet's own document is read back and never landed.** `fetch` returns
   * everyone's, mine included, which is what lets the page say whether the last
   * publish actually arrived — but importing it would propose this fleet's own
   * claims back to itself carrying its own fleet id as a second voice, and every
   * claim an operator vouched for would cross to `lookup` again on the next pulse
   * wearing evidence it had itself written. Nothing would error, and it would look
   * like another fleet agreeing.
   */
  private land(document: PoolClockDocument, now: string): void {
    try {
      if (document.fleetId === this.deps.fleetId) {
        this.deps.store.recordPoolFleetReading({
          fleetId: document.fleetId,
          project: document.project,
          claimsAt: document.kind === 'claims' ? document.publishedAt : null,
          digestAt: document.kind === 'digest' ? document.publishedAt : null,
          ahead: false,
        });
        return;
      }
      if (document.kind === 'digest') {
        this.deps.store.replacePoolFleetDigest(document.fleetId, document.project, document);
      } else {
        const arrivals = importClaims(this.deps.store, document, { project: this.deps.project, now });
        const mirrored: PoolMirroredClaim[] = arrivals.map(({ outcome: _outcome, ...claim }) => claim);
        this.deps.store.replacePoolFleetClaims(document.fleetId, mirrored);
      }
      this.deps.store.recordPoolFleetReading({
        fleetId: document.fleetId,
        project: document.project,
        claimsAt: document.kind === 'claims' ? document.publishedAt : null,
        digestAt: document.kind === 'digest' ? document.publishedAt : null,
        ahead: false,
      });
    } catch (error) {
      this.record(`Could not land ${document.fleetId}'s ${document.kind} document`, error);
    }
  }

  /**
   * Publish one document if it needs publishing.
   *
   * The two arms differ only in what makes them due, and the hash decides both: the
   * claims arm is due when an operator's ruling marked it dirty, the digest arm when
   * an hour has gone by — and either way what actually goes out is decided by
   * comparing the freshly derived content against what was last published.
   */
  private async publishKind(kind: PoolClockKind, boot: boolean): Promise<void> {
    const publication = this.deps.store.getPoolPublication(kind);
    const now = this.deps.now();
    const slowClockDue =
      boot ||
      publication.checkedAt === null ||
      new Date(now).getTime() - new Date(publication.checkedAt).getTime() >= this.deps.digestIntervalMs;
    // The claims arm's fast path; the digest arm has no fast path at all, because
    // nothing an operator does moves a number the way a ruling moves a claim.
    if (!slowClockDue && !(kind === 'claims' && publication.dirty)) return;

    let document: PoolClockDocument;
    try {
      document = this.derive(kind, now);
    } catch (error) {
      this.record(`Could not derive this fleet's ${kind} document`, error);
      return;
    }
    const hash = poolContentHash(document);
    if (hash === publication.contentHash) {
      // Nothing changed. Stamping the check rather than pushing is what keeps an
      // idle fleet from committing an identical file twenty-four times a day.
      this.deps.store.recordPoolChecked(kind);
      return;
    }
    try {
      await this.deps.transport.publish(document);
      this.deps.store.recordPoolPublish(kind, hash);
    } catch (error) {
      // Left dirty deliberately: the put is a whole replace, so the next pulse
      // re-derives and retries, and there is nothing to queue, reorder or replay.
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
    if (kind === 'digest') return buildDigestDocument(this.deps.store, context);
    const derived = buildClaimsDocument(this.deps.store, context);
    this.refusals = derived.refusals;
    return derived.document;
  }

  /**
   * One error record per failure, and no backoff.
   *
   * What a persistently failing pool needs is to be *visible*, which is this plus
   * the Knowledge page saying when this fleet last published successfully — not a
   * retry schedule that would mostly mean a recovered pool taking an hour to notice.
   */
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
  claims: import('../types.js').PoolPublication;
  digest: import('../types.js').PoolPublication;
  /** Claims the secret backstop refused, and why. Refusing is loud by design. */
  refusals: PoolRefusal[];
}
