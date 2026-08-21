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
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    for (const candidate of withExecExtensions(command, env)) {
      if (isExecutableFile(candidate)) return candidate;
    }
    throw new Error(`Agent command not found or not executable: ${command}`);
  }
  for (const dir of (envValue(env, 'PATH') ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of withExecExtensions(join(dir, command), env)) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  throw new Error(
    `Agent command '${command}' was not found on PATH. ` +
      `Install it, or set "claudeCommand" in the config to its absolute path.`,
  );
}

/**
 * On Windows an executable is found by appending a PATHEXT extension (`.EXE`,
 * `.CMD`, …) — a bare `claude` never matches `claude.exe`. Yield the base path
 * first (it already has an extension, or we're on a POSIX system) then each
 * PATHEXT candidate. On non-Windows this is just the base path, so POSIX
 * resolution is unchanged.
 */
function withExecExtensions(base: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [base];
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  if (exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()))) return [base];
  return [base, ...exts.map((e) => base + e)];
}

/**
 * Read an environment variable the way the *platform* would, not the way a plain
 * object would.
 *
 * Why this exists: Windows environment variables are case-insensitive, and
 * `process.env` models that with a proxy — but every caller here is handed a
 * **spread copy** (`{...process.env, ...spec.env}`), which is an ordinary object
 * with whatever casing the OS reported. A native Windows launcher (pwsh -> npm ->
 * cmd -> node) reports `Path`, so `env.PATH` is `undefined` and PATH lookup walks
 * an empty list — every dispatch fails with "not found on PATH" having never
 * touched the disk. Launched from Git Bash the same variable arrives as `PATH`
 * and it works, which is the whole reason this stayed hidden: the bug is a
 * property of the shell the harness was started from, not of the machine.
 *
 * POSIX env vars really are case-sensitive, so the fallback scan is win32-only.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (process.platform !== 'win32') return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
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
