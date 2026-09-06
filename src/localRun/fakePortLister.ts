import type { PortLister, PortOwner } from './ports.js';

// → docs/spec/23-local-runs.md

export class FakePortLister implements PortLister {
  readonly calls: PortOwner[] = [];
  private readonly held = new Map<string, number[] | null>();

  set(dir: string, ports: number[] | null): this {
    this.held.set(dir, ports);
    return this;
  }

  listening(run: PortOwner): Promise<number[] | null> {
    this.calls.push(run);
    return Promise.resolve(this.held.get(run.dir) ?? null);
  }
}
