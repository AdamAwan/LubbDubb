import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// → docs/spec/22-pets.md

export interface PetBuildStamp {
  sha: string | null;
  clean: boolean;
}

export function buildStamp(): PetBuildStamp {
  cached ??= read();
  return cached;
}

let cached: PetBuildStamp | null = null;

function read(): PetBuildStamp {
  const root = installRoot();
  if (root === null) return { sha: null, clean: false };
  try {
    const sha = git(root, ['rev-parse', 'HEAD']);
    const clean = git(root, ['status', '--porcelain']).length === 0;
    return { sha, clean };
  } catch {
    return { sha: null, clean: false };
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function installRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
