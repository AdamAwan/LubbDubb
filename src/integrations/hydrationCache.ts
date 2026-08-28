/**
 * The per-entity hydration cache every world-reading integration consults before
 * it fans out.
 *
 * The world read costs one or two list requests plus a handful **per open
 * entity**, every pulse — six per pull request and one per issue on GitHub,
 * three per pull request and one per owner-tagged work item on Azure. Almost
 * every one of those asks for something that has not moved since the last pulse.
 *
 * What that costs differs by provider, and neither answer is "nothing". GitHub
 * answers a conditional GET `304`, which does not count against the rate limit
 * at all (`github/etagCache.ts`), so what is left to spend there is latency and
 * request count. Azure DevOps documents `If-None-Match` on only a narrow slice
 * of its REST surface — `azure/conditionalRequests.ts` says which, and in short
 * not these — so an Azure request for something unmoved is paid for in full. On
 * both, the only way not to pay is not to make the request.
 *
 * So this holds what the last fan-out derived, keyed by entity id, beside a
 * **change token** read off the cheap list payload the pulse already fetched. A
 * caller that finds its token unmoved reuses what it holds and issues nothing.
 * The class is deliberately dumb about what a hit *means*: the token comparison
 * belongs to the caller, because only the caller knows which fields its own
 * token covers — and a token used to skip a read it does not cover is how a
 * cache starts lying.
 *
 * **A cache hit is not a stale reading, and must never set `WorldSlice.stale`.**
 * That flag means a read *failed* and the integration is serving its `lastGood`
 * — a world of unknown age, which `CompositeConnector` names on `staleSources`
 * so a decision taken against it can be discounted. A hit here is the opposite:
 * a *current* reading that cost no request, because the list payload fetched
 * this pulse said nothing moved. Conflating the two would mark a healthy fleet
 * permanently degraded and quietly devalue every decision it takes.
 * → [15](../../docs/spec/15-integrations.md#reading-less-before-retrying-harder)
 */

/**
 * The lane, not the cache, owns how long a hydration may be reused.
 *
 * There used to be a `MAX_REUSE_MS` here — five minutes, the backstop for the
 * fields **no token covers**: GitHub does not bump a pull request's `updated_at`
 * when the base branch advances underneath it, and Azure reports nothing when an
 * administrator adds, retires or reconfigures a branch policy. That backstop still
 * exists and is still the reason a hit expires at all; what changed is who states
 * it. One constant for every entity is one clock, and a clock here would silently
 * defeat a slower lane above it — every entry re-hydrating on the constant's
 * schedule whatever the lane decided, with nothing red. So the caller passes the
 * bound its lane gives it ({@link hydrationMaxAgeMs}) and this class holds no
 * policy at all.
 * → [04](../../docs/spec/04-harness-cycle.md#hot-and-cold)
 */

/**
 * The most entities held at once. Entries for entities that have left the
 * open/active set are dropped by {@link HydrationCache.retain} on the very next
 * snapshot, so this cap only bites where the live set is larger than it — and
 * there it costs a re-hydration and nothing else.
 */
const MAX_ENTRIES = 500;

/** A bounded, expiring map from entity id to whatever the caller hydrated for it. */
export class HydrationCache<V> {
  private readonly entries = new Map<number, { value: V; storedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The cached hydration, or undefined when absent or older than `maxAgeMs` — the
   * bound this entity's lane sets, handed in per call rather than held here.
   */
  get(key: number, maxAgeMs: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.storedAt >= maxAgeMs) {
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
