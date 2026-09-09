import { exec } from 'node:child_process';
import {
  idProjection,
  parseWatchResult,
  unanswered,
  type WatchQueryKind,
  type WatchResult,
} from '../environments/watchResult.js';

// → docs/spec/36-remote-validation.md

export type StateQueryKind = 'state' | 'presence';

export interface StateReadRequest {
  environment: string;
  command: string;
  queryId: string;
  query: string;
  kind: StateQueryKind;
}

export interface StateReader {
  read(request: StateReadRequest): Promise<WatchResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A `state` row answers with rows exactly as a signal does, so it is parsed as one: the id echo, the
 * rows-never-counts refusal and presence's zero-means-unknown are decided once, in watchResult.
 */
export function parsedAs(kind: StateQueryKind): WatchQueryKind {
  return kind === 'presence' ? 'presence' : 'signal';
}

export class CommandStateReader implements StateReader {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  read(request: StateReadRequest): Promise<WatchResult> {
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
            LUBBDUBB_WATCH_ID: request.queryId,
            LUBBDUBB_WATCH_QUERY: idProjection(request.query, request.queryId),
          },
        },
        (err, stdout, stderr) => {
          if (err !== null) return resolve(failure(err as ExecFailure, stderr));
          resolve(parseWatchResult(stdout, request.queryId, parsedAs(request.kind)));
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
    return unanswered(`the query was killed after ${err.signal ?? 'timeout'}`);
  const why = firstLine(stderr);
  return unanswered(`the query exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`);
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
