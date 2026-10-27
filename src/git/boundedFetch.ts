import type { ErrorRecorder } from '../errorLog.js';

// → docs/spec/09-execution.md#a-fetch-the-cycle-does-not-wait-for

export const CYCLE_FETCH_WAIT_MS = 30_000;

/**
 * Waits at most `waitMs` for `fetch`, then lets it finish behind the caller. A failure inside the
 * wait is the caller's, exactly as before; one after it is recorded here, once per distinct message.
 * While a fetch is running past its wait, a further call returns at once rather than waiting again.
 */
export function boundedFetch(
  fetch: (() => Promise<void>) | undefined,
  opts: { waitMs: number; errors: ErrorRecorder; what: string },
): (() => Promise<void>) | undefined {
  if (!fetch) return undefined;
  let lastLate: string | null = null;
  let overrunning: Promise<void> | null = null;
  return async () => {
    if (overrunning !== null) return;
    let waited = false;
    const running = fetch().then(
      () => {
        lastLate = null;
      },
      (err: unknown) => {
        if (!waited) throw err;
        const message = (err as Error).message;
        if (message === lastLate) return;
        lastLate = message;
        opts.errors.record({
          source: 'cycle',
          message: `${opts.what} could not fetch, after the cycle moved on: ${message}`,
        });
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((settled) => {
      timer = setTimeout(() => {
        waited = true;
        overrunning = running.finally(() => {
          overrunning = null;
        });
        settled();
      }, opts.waitMs);
      timer.unref();
    });
    try {
      await Promise.race([running, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}
