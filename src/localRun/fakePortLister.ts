import type { PortLister, PortOwner } from './ports.js';

/**
 * A scripted {@link PortLister} for tests, and the default under a fake transport
 * — `FakeGitObserver`'s shape: declare what a run's checkout holds, then assert on
 * `calls`. An undeclared checkout answers `null`, the honest default: nothing has
 * been said about it, so the lister cannot say.
 *
 * Keyed on the **directory** rather than the pid, because that is the half the real
 * lister can always answer from: a run whose session is gone still has a checkout,
 * and reports its ports.
 */
export class FakePortLister implements PortLister {
  /** Every run asked about, in order. */
  readonly calls: PortOwner[] = [];
  private readonly held = new Map<string, number[] | null>();

  /** Declare what the run in `dir` is listening on, or `null` for "could not say". */
  set(dir: string, ports: number[] | null): this {
    this.held.set(dir, ports);
    return this;
  }

  listening(run: PortOwner): Promise<number[] | null> {
    this.calls.push(run);
    return Promise.resolve(this.held.get(run.dir) ?? null);
  }
}
