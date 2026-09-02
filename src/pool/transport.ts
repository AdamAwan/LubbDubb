import type { PoolDocument } from '../types.js';

/**
 * How documents move between fleets.
 *
 * Four properties are load-bearing, and each is a property of the **contract**
 * rather than of any one substrate — so no transport has to be clever, and a
 * substrate added later cannot reintroduce a failure the first two were careful
 * about.
 *
 * **One writer per namespace.** A fleet writes its own documents and nobody else's.
 * The transport never merges, never reads before writing, and never reconciles.
 * Conflict-freedom is structural: two fleets cannot disagree about a byte because
 * they never address the same byte.
 *
 * **`publish` is a whole-document put**, never an append. Append needs
 * read-modify-write with ordering guarantees, and almost no substrate offers that
 * safely — which is how a distributed append becomes a lock, a queue and a replay
 * log. A full replace of your own document is idempotent and retryable everywhere,
 * and it is cheap precisely because the local store is the source of truth:
 * re-deriving the whole document is always correct. That one property is why a
 * failed publish needs no queue, why a lost dirty flag self-heals, why a withdrawal
 * needs no tombstone, and why an hourly cadence costs a hash rather than a commit.
 *
 * **The payload is opaque.** Versioned JSON; the transport moves bytes and the
 * layer above understands claims and digests.
 *
 * **`canRead: false` means publish-only.** A fleet on such a substrate contributes
 * to the shared page and consumes nothing: it runs no poller and holds no mirror.
 * Degraded explicitly, drawn as such, and never a fleet that silently believes it
 * is reading.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-transport`
 */
export interface PoolTransport {
  /** Stable id for the audit log and the cockpit, e.g. `pool:git`. */
  readonly id: string;
  readonly canRead: boolean;
  /** Replace **this fleet's** document of that kind, whole. Never an append, never a merge. */
  publish(document: PoolDocument): Promise<void>;
  /**
   * Remove **this fleet's** shared pack for that pull request, and its companion.
   *
   * The one thing a transport deletes, and narrow on purpose: only a pack is
   * pruned, so nothing can be asked to remove `claims.json`. A claim is durable; a
   * pack for a merged pull request is dead weight in a substrate every fleet
   * clones, and the publishing fleet drops it once the pull request has been
   * closed for `closedPrWindowMs`. One writer per namespace holds unchanged — the
   * address is inside the fleet's own directory — and removing what is not there
   * is a success, since the put is a whole replace and this is its inverse.
   * → `docs/spec/31-review-packs.md#sharing-a-pack`
   */
  unpublish(pack: PoolPackRef): Promise<void>;
  /** Everyone's documents, this fleet's included, as the bytes they were stored as. */
  fetch(): Promise<PoolFetchedDocument[]>;
}

/** Which shared pack to remove: this fleet's, for one pull request. */
export interface PoolPackRef {
  fleetId: string;
  prNumber: number;
}

/**
 * One document as the transport found it: the raw text, and the fleet id the
 * **address** claimed, when the substrate had one.
 *
 * The address is handed up rather than parsed down here, because checking it
 * against the body is the layer above's job — a substrate with no addresses at all
 * (a service later) simply says nothing, and the check is skipped rather than
 * failed. → `docs/spec/28-cross-fleet-pool.md#the-envelope`
 */
export interface PoolFetchedDocument {
  /** The fleet the address named, or null on a substrate whose addresses do not survive. */
  addressedTo: string | null;
  text: string;
}
