import { resolve } from 'node:path';
import { childrenFirst, type SlotProcess, type SlotProcesses } from './slotProcesses.js';

// → docs/spec/09-execution.md#a-process-left-standing-in-a-slot

export class FakeSlotProcesses implements SlotProcesses {
  readonly asked: string[] = [];
  readonly killed: number[] = [];
  private readonly holders = new Map<string, SlotProcess[]>();
  private readonly survives = new Set<number>();

  /** Declares what the sweep finds in `dir`, and what it goes on finding until `stop` takes them. */
  standing(dir: string, held: SlotProcess[]): this {
    this.holders.set(resolve(dir), held);
    return this;
  }

  /** A process the kill does not take — what a slot the harness cannot free looks like. */
  stubborn(pid: number): this {
    this.survives.add(pid);
    return this;
  }

  holding(dir: string): Promise<SlotProcess[]> {
    const key = resolve(dir);
    this.asked.push(key);
    return Promise.resolve(this.holders.get(key) ?? []);
  }

  stop(held: SlotProcess[]): Promise<void> {
    for (const p of childrenFirst(held)) this.killed.push(p.pid);
    for (const [dir, standing] of this.holders) {
      const left = standing.filter((p) => this.survives.has(p.pid) || !held.some((k) => k.pid === p.pid));
      if (left.length === 0) this.holders.delete(dir);
      else this.holders.set(dir, left);
    }
    return Promise.resolve();
  }
}
