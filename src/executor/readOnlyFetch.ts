import type { ErrorRecorder } from '../errorLog.js';

// → docs/spec/09-execution.md (the read-only checkout)

export function readOnlyFetch(
  fetch: (() => Promise<void>) | undefined,
  errors: ErrorRecorder,
): (() => Promise<void>) | undefined {
  if (!fetch) return undefined;
  let lastError: string | null = null;
  return async () => {
    try {
      await fetch();
      lastError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (message === lastError) return;
      lastError = message;
      errors.record({ source: 'cycle', message: `Read-only checkout could not fetch: ${message}` });
    }
  };
}
