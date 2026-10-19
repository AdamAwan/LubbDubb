import type { EnvironmentObservationRequest, EnvironmentObserver } from './observer.js';
import { parseWatchResult, preparedQuery, unanswered, WATCH_ID_COLUMN, type WatchResult } from './watchResult.js';
import { aggregatingTail } from '../validation/watchQueryShape.js';
import {
  commitsVariable,
  EXPOSURE_ECHO_COLUMN,
  parseExposure,
  unexposed,
  type ExposureReading,
  type ExposureRequest,
} from './exposure.js';

// → docs/spec/24-environments.md

export class FakeEnvironmentObserver implements EnvironmentObserver {
  readonly asked: Omit<EnvironmentObservationRequest, 'command'>[] = [];
  readonly exposureAsked: Omit<ExposureRequest, 'command'>[] = [];
  /** The share the scripted exposure probe answers, echoing what it was asked; a string is printed verbatim. */
  exposureOutput: number | string | undefined;

  constructor(private readonly output: Record<string, string> = {}) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    const { environment, checkId, kind, query, since, commits } = request;
    this.asked.push({ environment, checkId, kind, query, since, ...(commits === undefined ? {} : { commits }) });
    const prepared = preparedQuery(query, since, checkId, kind);
    if (prepared.query === null) return Promise.resolve(unanswered(prepared.refusal));
    const stdout = this.output[`${checkId}:${kind}`];
    if (stdout === undefined) return Promise.resolve(unanswered('unscripted'));
    const result = parseWatchResult(stdout, checkId, kind);
    if (kind === 'measure' || result.rows === null || aggregatingTail(query) === null) return Promise.resolve(result);
    return Promise.resolve(
      parseWatchResult(JSON.stringify([watchRow(checkId, { count_: result.rows.length })]), checkId, kind),
    );
  }

  exposure(request: ExposureRequest): Promise<ExposureReading> {
    this.exposureAsked.push({ environment: request.environment, commits: request.commits });
    const out = this.exposureOutput;
    if (out === undefined) return Promise.resolve(unexposed('unscripted'));
    const stdout =
      typeof out === 'string'
        ? out
        : JSON.stringify({ [EXPOSURE_ECHO_COLUMN]: commitsVariable(request.commits), share: out });
    return Promise.resolve(parseExposure(stdout, request.commits));
  }
}

export function watchRow(checkId: string, row: Record<string, string | number> = {}): Record<string, unknown> {
  return { ...row, [WATCH_ID_COLUMN]: checkId };
}
