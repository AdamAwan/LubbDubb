import { createRequire } from 'node:module';
import { resolveExecutable } from '../agents/resolveCommand.js';

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

// Default PTY geometry. The legible-transcript emulator (terminalTranscript.ts)
// must model the same screen size or cursor-addressed redraws land on the wrong
// rows, so both read these constants.
export const PTY_COLS = 120;
export const PTY_ROWS = 40;

/**
 * Real backend backed by node-pty. Imported lazily so environments/tests that
 * never spawn a real terminal don't need the native addon built.
 */
export class NodePtyBackend implements PtyBackend {
  spawn(file: string, args: string[], opts: SpawnOptions): PtyProcess {
    // Lazy require keeps the native dependency off the import path for tests.
    const require = createRequire(import.meta.url);
    const pty = require('node-pty') as typeof import('node-pty');
    const env = { ...process.env, ...opts.env } as Record<string, string>;
    // Resolve up front: node-pty reports a missing binary only by exiting 1 with
    // `execvp(3) failed` in the terminal, so a bad command would otherwise look
    // like an agent that spawned and instantly "failed" for no visible reason.
    const command = resolveExecutable(file, env);
    const proc = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: opts.cols ?? PTY_COLS,
      rows: opts.rows ?? PTY_ROWS,
      cwd: opts.cwd,
      env,
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
