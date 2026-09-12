import { exec } from 'node:child_process';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { PrReview, PrReviewRoute, WorldSnapshot } from '../types.js';
import type { PrReviewPolicy } from './policy.js';
import { needsFleetReview, reviewReading } from './prReview.js';

// → docs/spec/31-review-packs.md

export type ReviewedElsewhere = 'reviewed' | 'not-reviewed' | 'unknown';

export interface ReviewedElsewhereReport {
  verdict: ReviewedElsewhere;
  detail: string | null;
}

export interface ReviewProber {
  check(prNumber: number, command: string): Promise<ReviewedElsewhereReport>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CommandReviewProber implements ReviewProber {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  check(prNumber: number, command: string): Promise<ReviewedElsewhereReport> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: { ...process.env, LUBBDUBB_PR: String(prNumber) },
        },
        (err, _stdout, stderr) => {
          if (err === null) return resolve({ verdict: 'reviewed', detail: null });
          const failure = err as ExecFailure;
          if (failure.killed === true || (failure.signal !== null && failure.signal !== undefined)) {
            return resolve({
              verdict: 'unknown',
              detail: `the check was killed after ${failure.signal ?? 'timeout'}`,
            });
          }
          if (failure.code === undefined || typeof failure.code === 'string') {
            return resolve({
              verdict: 'unknown',
              detail: `the check could not be run: ${firstLine(stderr) ?? failure.message}`,
            });
          }
          return resolve({ verdict: 'not-reviewed', detail: null });
        },
      );
    });
  }
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}

export async function askReviewedElsewhere(
  deps: { store: Store; errors: ErrorRecorder; review: PrReviewPolicy; reviewProber?: ReviewProber },
  at: { dispatchWorld: WorldSnapshot; prReviews: PrReview[]; prReviewRoutes: PrReviewRoute[] },
): Promise<void> {
  const prober = deps.reviewProber;
  const command = deps.review.reviewedElsewhere;
  if (prober === undefined || command === null || command.trim() === '') return;
  const rows = {
    prReviews: new Map(at.prReviews.map((r) => [r.prNumber, r])),
    prReviewRoutes: new Map(at.prReviewRoutes.map((r) => [r.prNumber, r])),
    prReviewedElsewhere: deps.store.prReviewExternals.prsReviewedElsewhere(),
  };
  for (const pr of at.dispatchWorld.pullRequests) {
    if (!needsFleetReview(pr, reviewReading(rows, pr.number), deps.review)) continue;
    const report = await prober.check(pr.number, command);
    if (report.verdict === 'reviewed') {
      deps.store.prReviewExternals.recordPrReviewedElsewhere(pr.number, command);
      continue;
    }
    if (report.verdict === 'unknown') {
      deps.errors.record({
        source: 'cycle',
        message: `the review.reviewedElsewhere check for PR ${pr.number} said nothing: ${report.detail ?? 'no detail'}`,
      });
    }
  }
}
