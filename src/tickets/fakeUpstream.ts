import type { FilingTarget } from '../sink/actionSink.js';
import type { UpstreamIssues } from './upstream.js';
import { UPSTREAM_REPO } from './upstream.js';

/**
 * A scripted {@link UpstreamIssues} — the seam's fake, injected by every test that
 * touches the two collection-level issue routes.
 *
 * It exists for the reason `FakeWorktreeManager` does: the real one spawns a CLI
 * against a live GitHub, so a test that reached it would either file a real issue
 * on {@link UPSTREAM_REPO} or fail by whichever machine ran it. Both readings the
 * routes have arms for — the CLI absent, and the CLI refusing — are set by
 * constructing this with a failure.
 */
export class FakeUpstreamIssues implements UpstreamIssues {
  /** Everything filed through it, in order — what a test asserts the labels on. */
  readonly filed: Array<{ title: string; body: string; labels: string[] }> = [];
  private next = 1000;

  /** `fails` is the CLI's own words, thrown by both arms exactly as the real one does. */
  constructor(private readonly fails: string | null = null) {}

  async describeTarget(): Promise<FilingTarget> {
    if (this.fails !== null) throw new Error(this.fails);
    return { target: UPSTREAM_REPO, identity: 'octocat' };
  }

  async create(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    if (this.fails !== null) throw new Error(this.fails);
    this.filed.push({ ...input, labels: [...input.labels] });
    const number = this.next++;
    return { number, url: `https://github.com/${UPSTREAM_REPO}/issues/${number}` };
  }
}
