import type { ReviewedElsewhere, ReviewedElsewhereReport, ReviewProber } from './reviewedElsewhere.js';

// → docs/spec/07-pull-requests.md#the-fleet-review

export class FakeReviewProber implements ReviewProber {
  readonly asked: number[] = [];

  constructor(private readonly verdicts: Record<number, ReviewedElsewhere> = {}) {}

  check(prNumber: number, _command: string): Promise<ReviewedElsewhereReport> {
    this.asked.push(prNumber);
    const verdict = this.verdicts[prNumber] ?? 'unknown';
    return Promise.resolve({
      verdict,
      detail: verdict === 'unknown' ? 'unscripted' : null,
    });
  }
}
