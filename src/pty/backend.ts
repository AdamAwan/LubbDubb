import { createRequire } from 'node:module';

/**
 * The tiny slice of a pseudo-terminal the harness actually needs. Abstracting it
 * lets tests drive a scripted process without the native `node-pty` addon, and
 * keeps the (heuristic, fiddly) session logic in one testable place.
 */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (evt: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyBackend {
  spawn(command: string, args: string[], opts: SpawnOptions): PtyProcess;
}

/**
 * Real backend backed by node-pty. Imported lazily so environments/tests that
 * never spawn a real terminal don't need the native addon built.
 */
export class NodePtyBackend implements PtyBackend {
  spawn(command: string, args: string[], opts: SpawnOptions): PtyProcess {
    // Lazy require keeps the native dependency off the import path for tests.
    const require = createRequire(import.meta.url);
    const pty = require('node-pty') as typeof import('node-pty');
    const proc = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });
    return {
      pid: proc.pid,
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
      write: (data) => proc.write(data),
      kill: (signal) => proc.kill(signal),
    };
  }
}
