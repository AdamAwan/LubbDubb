/**
 * The per-entity hydration cache the two GitHub integrations read before they
 * fan out.
 *
 * The world read costs one list request plus a handful *per open entity* — six
 * per pull request, one per issue — every pulse. `etagCache.ts` already makes an
 * unchanged response free against the rate limit (a `304` does not count), so
 * what is left to spend is **latency and request count**, and the only way to
 * stop spending those is to not make the request. This holds the hydrated domain
 * object from the last fan-out, keyed by entity number, beside a *change token*
 * read off the cheap list payload; a caller that finds the token unmoved reuses
 * what it has and issues nothing.
 *
 * **A cache hit is not a stale reading, and must never set `WorldSlice.stale`.**
 * That flag means a read *failed* and the provider is serving `lastGood` — a
 * world some unknown age old, which `CompositeConnector` names on
 * `staleSources` so a decision taken against it can be discounted. A hit here is
 * the opposite: the reading is current, GitHub having told us (on the list
 * payload we fetched this pulse) that nothing moved. Conflating the two would
 * mark a healthy fleet permanently degraded and quietly devalue every decision
 * it takes. → [15](../../../docs/spec/15-integrations.md#reading-less-before-retrying-harder)
 */

/**
 * How long a cached hydration may be reused before the next read is paid for
 * regardless of its token.
 *
 * A backstop for the fields **no token covers**: GitHub bumps a pull request's
 * `updated_at` for things done *to* it, not for the world moving underneath it,
 * so a `mergeable_state` that turns `behind` or `dirty` because the base branch
 * advanced moves no token this module can see. The same is true of an issue
 * whose only change is a cross-reference from somewhere else. Rather than reuse
 * those indefinitely, every entry expires — so the worst case is exactly the
 * freshness the fleet had at the old five-minute heartbeat, and everything
 * faster than that is saved requests rather than a new blind spot.
 */
const MAX_REUSE_MS = 5 * 60_000;

/**
 * The most entities held at once. A fleet that runs for months across a
 * repository's whole PR history must not grow this without bound; entries for
 * entities that have left the open set are dropped by {@link retain} on the very
 * next snapshot anyway, so the cap only ever bites on a repository whose open
 * set is larger than it, where the eviction costs a re-hydration and nothing
 * else.
 */
const MAX_ENTRIES = 500;

/**
 * A bounded, expiring map from entity number to whatever the caller hydrated for
 * it. Deliberately dumb about *what* a hit means — the token comparison is the
 * caller's, because only the caller knows which fields its token covers.
 */
export class HydrationCache<V> {
  private readonly entries = new Map<number, { value: V; storedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The cached hydration, or undefined when absent or past {@link MAX_REUSE_MS}. */
  get(key: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.storedAt >= MAX_REUSE_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: number, value: V): void {
    // Re-inserted rather than overwritten so `entries` stays in recency order and
    // the eviction below drops the least recently hydrated.
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop everything outside the live set — the entities that have closed or merged. */
  retain(keys: Iterable<number>): void {
    const live = new Set(keys);
    for (const key of this.entries.keys()) if (!live.has(key)) this.entries.delete(key);
  }
}
