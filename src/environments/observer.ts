import { exec } from 'node:child_process';
import {
  parseWatchResult,
  preparedQuery,
  unanswered,
  type WatchPeriod,
  type WatchQueryKind,
  type WatchResult,
} from './watchResult.js';
import { firstLine } from '../primitives.js';
import type { WatchSourceLanguage } from '../types.js';
import { commitsVariable, parseExposure, unexposed, type ExposureReading, type ExposureRequest } from './exposure.js';

// → docs/spec/24-environments.md

export interface EnvironmentObservationRequest extends WatchPeriod {
  environment: string;
  command: string;
  /** The source's name, passed so one wrapper can serve several; and its language, which says how the id is echoed. */
  source: string;
  language: WatchSourceLanguage;
  checkId: string;
  query: string;
  kind: WatchQueryKind;
  /** The goal's landed commits, for a query scoped to traffic running them; absent at the dry run. */
  commits?: readonly string[];
}

/** Everything one check's observations on one source share; each read adds its `query` and `kind`. */
export function observationAsk(
  environment: string,
  source: { name: string; language: WatchSourceLanguage; observe: string },
  checkId: string,
  period: WatchPeriod,
): Omit<EnvironmentObservationRequest, 'query' | 'kind'> {
  return {
    environment,
    command: source.observe,
    source: source.name,
    language: source.language,
    checkId,
    since: period.since,
    until: period.until,
  };
}

export interface EnvironmentObserver {
  observe(request: EnvironmentObservationRequest): Promise<WatchResult>;
  exposure(request: ExposureRequest): Promise<ExposureReading>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CommandEnvironmentObserver implements EnvironmentObserver {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    const prepared = preparedQuery(request.query, request, request.checkId, request.kind, request.language);
    if (prepared.query === null) return Promise.resolve(unanswered(prepared.refusal));
    return this.run(
      request.command,
      {
        LUBBDUBB_ENVIRONMENT: request.environment,
        LUBBDUBB_WATCH_ID: request.checkId,
        LUBBDUBB_WATCH_SOURCE: request.source,
        LUBBDUBB_WATCH_QUERY: prepared.query,
        LUBBDUBB_WATCH_SINCE: request.since,
        LUBBDUBB_WATCH_UNTIL: request.until,
        ...(request.commits === undefined ? {} : { LUBBDUBB_WATCH_COMMITS: commitsVariable(request.commits) }),
      },
      (stdout) => parseWatchResult(stdout, request.checkId, request.kind),
      (detail) => unanswered(`the observation ${detail}`),
    );
  }

  exposure(request: ExposureRequest): Promise<ExposureReading> {
    if (request.commits.length === 0) return Promise.resolve(unexposed('the goal has no landed commit to ask about'));
    return this.run(
      request.command,
      { LUBBDUBB_ENVIRONMENT: request.environment, LUBBDUBB_WATCH_COMMITS: commitsVariable(request.commits) },
      (stdout) => parseExposure(stdout, request.commits),
      (detail) => unexposed(`the exposure probe ${detail}`),
    );
  }

  private run<T>(
    command: string,
    env: Record<string, string>,
    parse: (stdout: string) => T,
    fail: (detail: string) => T,
  ): Promise<T> {
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: this.repoRoot, timeout: this.timeoutMs, windowsHide: true, env: { ...process.env, ...env } },
        (err, stdout, stderr) => resolve(err === null ? parse(stdout) : fail(failure(err as ExecFailure, stderr))),
      );
    });
  }
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function failure(err: ExecFailure, stderr: string): string {
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return `was killed after ${err.signal ?? 'timeout'}`;
  const why = firstLine(stderr);
  return `exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`;
}
