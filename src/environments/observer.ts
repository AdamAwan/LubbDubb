import { exec } from 'node:child_process';
import { idProjection, parseWatchResult, unanswered, type WatchQueryKind, type WatchResult } from './watchResult.js';

// → docs/spec/24-environments.md

export interface EnvironmentObservationRequest {
  environment: string;
  command: string;
  checkId: string;
  query: string;
  kind: WatchQueryKind;
}

export interface EnvironmentObserver {
  observe(request: EnvironmentObservationRequest): Promise<WatchResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CommandEnvironmentObserver implements EnvironmentObserver {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    return new Promise((resolve) => {
      exec(
        request.command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: {
            ...process.env,
            LUBBDUBB_ENVIRONMENT: request.environment,
            LUBBDUBB_WATCH_ID: request.checkId,
            LUBBDUBB_WATCH_QUERY: idProjection(request.query, request.checkId),
          },
        },
        (err, stdout, stderr) => {
          if (err !== null) return resolve(failure(err as ExecFailure, stderr));
          resolve(parseWatchResult(stdout, request.checkId, request.kind));
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

function failure(err: ExecFailure, stderr: string): WatchResult {
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return unanswered(`the observation was killed after ${err.signal ?? 'timeout'}`);
  const why = firstLine(stderr);
  return unanswered(`the observation exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`);
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
