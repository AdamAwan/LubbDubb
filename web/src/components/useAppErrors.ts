import type { AppErrorsPayload } from '../types.js';
import { api } from '../api.js';
import { usePolled } from '../hooks.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

const REFRESH_MS = 60_000;

/** The Errors tab and every goal header's badge read this one poll. */
export function useAppErrors(): { reading: AppErrorsPayload | null; failed: boolean; reload: () => void } {
  return usePolled(api.getAppErrors, REFRESH_MS);
}
