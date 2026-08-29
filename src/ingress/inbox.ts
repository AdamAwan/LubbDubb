/**
 * The refs a delivery has said are stale, waiting for the next world read to pick
 * them up.
 *
 * **This is the whole of the invalidation.** Stage 1 made the per-entity read
 * change-gated by holding what the last fan-out derived beside a token off the
 * cheap list payload (`src/integrations/hydrationCache.ts`); stage 3 made the age
 * backstop on that reuse a per-entity number the lane hands in
 * (`src/world/readPlan.ts`). So "drop this one entity's hydration" is already
 * expressible: the next plan gives that ref an age bound of **zero**, `get`
 * finds every entry older than that, deletes it and returns nothing, and the
 * entity re-hydrates. Nothing else in the cache is touched, no integration grows
 * a method, and no code path exists that could drop the whole cache by mistake.
 * → `docs/spec/30-ingress.md#invalidating-precisely`
 *
 * In memory and nowhere else. A delivery is an optimisation over polling, so a
 * restart that forgets one costs at most a cold lane's interval — and a durable
 * queue of "things to re-read" would be a second source of truth about the world
 * with its own way of being wrong.
 */

/**
 * The most refs held at once.
 *
 * A verified flood naming a fresh entity every time would otherwise grow this
 * without bound, and each ref in it is a fan-out the next pulse pays for. Over the
 * cap a mark is **dropped**, not queued: the lane's own backstop still re-reads
 * that entity, so what is lost is latency on one entity and never correctness.
 */
const MAX_PENDING = 512;

/** Marked by the ingress, drained by the pulse. Nothing else touches it. */
export class IngressInbox {
  private readonly pending = new Set<string>();

  /** Note that these entities' hydrations are stale. */
  mark(refs: readonly string[]): void {
    for (const ref of refs) {
      if (this.pending.size >= MAX_PENDING && !this.pending.has(ref)) return;
      this.pending.add(ref);
    }
  }

  /**
   * Take everything marked, leaving the inbox empty.
   *
   * @public reached through `HarnessDeps.freshReads`, the structural seam the pulse
   * drains it by.
   *
   * Drained when the plan is *built*, which is before the read it feeds. A read
   * that then fails loses the invalidation — and that is the right trade rather
   * than an oversight: holding refs until a read succeeds means a provider outage
   * accumulates a re-read list that lands as one enormous fan-out on recovery,
   * while the lane backstop already covers the entity within its own interval.
   */
  drain(): string[] {
    const refs = [...this.pending];
    this.pending.clear();
    return refs;
  }
}
