import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Resolve an agent launch command to an executable absolute path, the way a
 * shell's PATH lookup would.
 *
 * Why this exists: both spawn transports fail *silently* on a missing binary.
 * `node-pty`'s forked child just prints `execvp(3) failed.: No such file or
 * directory` into the terminal and exits 1, and `child_process.spawn` emits an
 * async `error` event — so a mistyped or not-installed `claudeCommand` surfaces
 * only as an agent that mysteriously "failed" with no thrown error (the PTY
 * spawn-failure this guards against). Resolving up front turns that into a clear,
 * actionable error at spawn time, and hands the runtime an absolute path so the
 * child no longer depends on inheriting a correct PATH.
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  // An explicit path (absolute or containing a separator) is taken as-is — only checked.
  if (isAbsolute(command) || command.includes('/')) {
    if (isExecutableFile(command)) return command;
    throw new Error(`Agent command not found or not executable: ${command}`);
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    `Agent command '${command}' was not found on PATH. ` +
      `Install it, or set "claudeCommand" in the config to its absolute path.`,
  );
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
