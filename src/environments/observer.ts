import { exec } from 'node:child_process';
import { parseWatchResult, preparedQuery, unanswered, type WatchQueryKind, type WatchResult } from './watchResult.js';
import { firstLine } from '../primitives.js';
import { commitsVariable, parseExposure, unexposed, type ExposureReading, type ExposureRequest } from './exposure.js';

// → docs/spec/24-environments.md

export interface EnvironmentObservationRequest {
  environment: string;
  command: string;
  checkId: string;
  query: string;
  kind: WatchQueryKind;
  /** The instant the reading is about: what the query's `{since}` is replaced with. */
  since: string;
  /** The goal's landed commits, for a query scoped to traffic running them; absent at the dry run. */
  commits?: readonly string[];
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
    const prepared = preparedQuery(request.query, request.since, request.checkId, request.kind);
    if (prepared.query === null) return Promise.resolve(unanswered(prepared.refusal));
    return this.run(
      request.command,
      {
        LUBBDUBB_ENVIRONMENT: request.environment,
        LUBBDUBB_WATCH_ID: request.checkId,
        LUBBDUBB_WATCH_QUERY: prepared.query,
        LUBBDUBB_WATCH_SINCE: request.since,
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
