import type { PortLister } from './ports.js';

/**
 * A scripted {@link PortLister} for tests, and the default under a fake transport
 * — `FakeGitObserver`'s shape: declare what a pid's tree holds, then assert on
 * `calls`. An undeclared pid answers `null`, the honest default: nothing has been
 * said about it, so the lister cannot say.
 */
export class FakePortLister implements PortLister {
  /** Every root pid asked about, in order. */
  readonly calls: number[] = [];
  private readonly held = new Map<number, number[] | null>();

  /** Declare what `rootPid`'s tree is listening on, or `null` for "could not say". */
  set(rootPid: number, ports: number[] | null): this {
    this.held.set(rootPid, ports);
    return this;
  }

  listening(rootPid: number): Promise<number[] | null> {
    this.calls.push(rootPid);
    return Promise.resolve(this.held.get(rootPid) ?? null);
  }
}
