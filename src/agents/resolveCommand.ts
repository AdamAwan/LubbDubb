import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// → docs/spec/10-agent-runtimes.md

export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
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

function withExecExtensions(base: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [base];
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  if (exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()))) return [base];
  return [base, ...exts.map((e) => base + e)];
}

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
