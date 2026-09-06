import type { FilingTarget } from '../sink/actionSink.js';
import type { UpstreamIssues } from './upstream.js';
import { UPSTREAM_REPO } from './upstream.js';

// → docs/spec/13-jobs-and-tickets.md

export class FakeUpstreamIssues implements UpstreamIssues {
  readonly filed: Array<{ title: string; body: string; labels: string[] }> = [];
  private next = 1000;

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
