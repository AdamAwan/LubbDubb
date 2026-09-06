// → docs/spec/15-integrations.md

const MAX_ENTRIES = 500;

export class HydrationCache<V> {
  private readonly entries = new Map<number, { value: V; storedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

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
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  retain(keys: Iterable<number>): void {
    const live = new Set(keys);
    for (const key of this.entries.keys()) if (!live.has(key)) this.entries.delete(key);
  }
}
