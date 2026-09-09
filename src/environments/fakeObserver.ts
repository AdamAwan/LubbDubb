import type { EnvironmentObservationRequest, EnvironmentObserver } from './observer.js';
import { parseWatchResult, unanswered, WATCH_ID_COLUMN, type WatchResult } from './watchResult.js';
import { aggregatingTail } from '../validation/watchQueryShape.js';

// → docs/spec/24-environments.md

export class FakeEnvironmentObserver implements EnvironmentObserver {
  readonly asked: { environment: string; checkId: string; kind: string; query: string }[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    const { environment, checkId, kind, query } = request;
    this.asked.push({ environment, checkId, kind, query });
    const stdout = this.output[`${checkId}:${kind}`];
    if (stdout === undefined) return Promise.resolve(unanswered('unscripted'));
    const result = parseWatchResult(stdout, checkId, kind);
    if (kind === 'measure' || result.rows === null || aggregatingTail(query) === null) return Promise.resolve(result);
    return Promise.resolve(
      parseWatchResult(JSON.stringify([watchRow(checkId, { count_: result.rows.length })]), checkId, kind),
    );
  }
}

export function watchRow(checkId: string, row: Record<string, string | number> = {}): Record<string, unknown> {
  return { ...row, [WATCH_ID_COLUMN]: checkId };
}
