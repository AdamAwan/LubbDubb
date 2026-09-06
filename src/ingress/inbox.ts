// → docs/spec/30-ingress.md

const MAX_PENDING = 512;

export class IngressInbox {
  private readonly pending = new Set<string>();

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
