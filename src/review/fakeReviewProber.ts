import type { ReviewedElsewhere, ReviewedElsewhereReport, ReviewProber } from './reviewedElsewhere.js';

/**
 * A scripted review prober: answers with whatever verdict a test scripted for a
 * pull request's number, and `unknown` for anything unscripted — the honest
 * default, since a check nobody has told what to answer has not answered, and it
 * is the arm that must leave the fleet reviewing.
 *
 * The seam exists so no test spawns a shell, exactly as
 * {@link FakeEnvironmentHealthProber} does. A test that let
 * {@link CommandReviewProber} run would be asserting on the machine's `sh` and on
 * whatever the developer happened to have exported.
 */
export class FakeReviewProber implements ReviewProber {
  /** Every pull request asked, in order — what a test asserts the per-pulse cost with. */
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
