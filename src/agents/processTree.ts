import { spawnSync } from 'node:child_process';

/**
 * Take down a process **and everything it started**, by root pid.
 *
 * Injected rather than called directly so the composition root wires the real one
 * and a test wires a recorder: the real implementation signals whatever pid it is
 * handed, and the fake transports (`FakePtyBackend`, an injected `Spawner`) mint
 * pids that belong to *other people's processes* on the host. A seam is the only
 * safe way to have this in the runtimes at all.
 */
export type ProcessReaper = (pid: number) => void;

/**
 * The default reaper, and the one the harness runs with.
 *
 * **An agent's children outlive the agent.** Killing or interrupting a session
 * signals the `claude` process alone; a shell it started with the Bash tool — and
 * that shell's own children — survive with their cwd still set to the agent's
 * worktree. Windows then refuses `rmdir` on any live process's cwd, so the branch
 * is wedged: every later dispatch onto it fails `EBUSY` in
 * {@link WorktreeManager.reclaim}, ~45s apart, until someone kills the shells by
 * hand. Reaping the subtree is what stops that at the source.
 *
 * Two platforms, two mechanisms, because Windows has no process group to signal:
 *
 * - **Windows** — `taskkill /T /F`, which walks the parent-pid links itself and
 *   kills the root along with every descendant. Synchronous (`spawnSync`) so the
 *   tree is gone before the caller signals anything else.
 * - **POSIX** — `kill(-pid)`, the process *group*. The group exists because the
 *   spawners put the child at the head of one: `defaultSpawner` passes
 *   `detached: true`, and node-pty's `forkpty` calls `setsid` for us. A group that
 *   turns out not to exist (`ESRCH`/`EPERM`) falls back to the bare pid, which is
 *   no worse than the behaviour this replaced.
 *
 * **The tree must still be walkable**, which is the one thing callers have to get
 * right: both mechanisms resolve descendants *through the root*, so they must run
 * while the root is alive. A pid that has already exited leaves children that were
 * reparented and can no longer be found from here — see
 * [10](../../docs/spec/10-agent-runtimes.md#reaping-the-process-subtree).
 *
 * Never throws. A reap that fails must not take a kill path down with it — the
 * agent still has to be marked, the transcript flushed and the credential
 * released — so failures are reported to `onError` and the caller carries on.
 */
export function killProcessTree(pid: number, onError?: (message: string) => void): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      if (res.error) throw res.error;
      // 128 is taskkill's "process not found" — the tree is already gone, which is
      // the outcome asked for, not a failure.
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
      // No group of its own (or gone already): the direct child is all there is to signal.
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
