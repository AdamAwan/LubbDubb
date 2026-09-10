import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot(): string {
  const from = dirname(fileURLToPath(import.meta.url));
  let dir = from;
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`no package.json above ${from}`);
}

export const REPO_ROOT = findRoot();

export function repoPath(...segments: readonly string[]): string {
  return join(REPO_ROOT, ...segments);
}

export function repoText(...segments: readonly string[]): string {
  return readFileSync(repoPath(...segments), 'utf8');
}
