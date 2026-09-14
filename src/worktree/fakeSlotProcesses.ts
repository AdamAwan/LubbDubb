import { resolve } from 'node:path';
import { childrenFirst, type SlotProcess, type SlotProcesses } from './slotProcesses.js';

// → docs/spec/09-execution.md#a-process-left-standing-in-a-slot

export class FakeSlotProcesses implements SlotProcesses {
  readonly asked: string[] = [];
  /** The paths each probe was asked about, in the order the probes were made. */
  readonly askedPaths: string[][] = [];
  readonly killed: number[] = [];
  private readonly holders = new Map<string, SlotProcess[]>();
  private readonly survives = new Set<number>();
  private readonly unanswerable = new Set<string>();

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

  /** A probe that cannot say — the process table refused, timed out, or was not there to read. */
  unreadable(dir: string, cannot = true): this {
    if (cannot) this.unanswerable.add(resolve(dir));
    else this.unanswerable.delete(resolve(dir));
    return this;
  }

  holding(dir: string, paths?: string[]): Promise<SlotProcess[] | null> {
    const key = resolve(dir);
    this.asked.push(key);
    this.askedPaths.push(paths ?? []);
    if (this.unanswerable.has(key)) return Promise.resolve(null);
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
