import type { EnvironmentObservationRequest, EnvironmentObserver } from './observer.js';
import { parseWatchResult, unanswered, WATCH_ID_COLUMN, type WatchResult } from './watchResult.js';

// → docs/spec/24-environments.md

export class FakeEnvironmentObserver implements EnvironmentObserver {
  readonly asked: { environment: string; checkId: string; kind: string; query: string }[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    const { environment, checkId, kind, query } = request;
    this.asked.push({ environment, checkId, kind, query });
    const stdout = this.output[`${checkId}:${kind}`];
    if (stdout === undefined) return Promise.resolve(unanswered('unscripted'));
    return Promise.resolve(parseWatchResult(stdout, checkId, kind));
  }
}

export function watchRow(checkId: string, row: Record<string, string | number> = {}): Record<string, unknown> {
  return { ...row, [WATCH_ID_COLUMN]: checkId };
}
