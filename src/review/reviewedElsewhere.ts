import { exec } from 'node:child_process';

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
