import { spawnSync } from 'node:child_process';

// → docs/spec/10-agent-runtimes.md

export type ProcessReaper = (pid: number) => void;

export function killProcessTree(pid: number, onError?: (message: string) => void): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      if (res.error) throw res.error;
      if (res.status !== 0 && res.status !== 128) {
        const detail = (res.stderr?.toString() ?? '').trim();
        throw new Error(`taskkill exited ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw err;
      try {
        process.kill(pid, 'SIGTERM');
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== 'ESRCH') throw inner;
      }
    }
  } catch (err) {
    onError?.(`Could not reap the process subtree of pid ${pid}: ${(err as Error).message}`);
  }
}
