import { createRequire } from 'node:module';
import { resolveExecutable } from '../agents/resolveCommand.js';

// → docs/spec/10-agent-runtimes.md

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

const PTY_COLS = 120;
const PTY_ROWS = 40;

export class NodePtyBackend implements PtyBackend {
  spawn(file: string, args: string[], opts: SpawnOptions): PtyProcess {
    const require = createRequire(import.meta.url);
    const pty = require('node-pty') as typeof import('node-pty');
    const env = { ...process.env, ...opts.env } as Record<string, string>;
    // TECHDEBT: Resolve up front: node-pty reports a missing binary only by exiting 1 with
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
      // TECHDEBT: node-pty's Windows backend terminates via a job object and *throws* on any
      // signal argument ("Signals not supported on windows"); drop the signal there.
      // POSIX honours it, so keep passing SIGTERM etc. off Windows.
      kill: (signal) => proc.kill(process.platform === 'win32' ? undefined : signal),
    };
  }
}
