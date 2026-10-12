import { createRequire } from 'node:module';
import { runGit } from '../git/gitCli.js';
import { installRoot } from '../selfUpdate/buildStanding.js';

// → docs/spec/28-cross-fleet-pool.md

export function harnessVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function harnessBuild(root: string | null = installRoot()): Promise<string> {
  const version = harnessVersion();
  if (root === null) return version;
  const head = (await runGit(root, ['rev-parse', '--short=12', 'HEAD'])).stdout.trim();
  return head === '' ? version : `${version}+${head}`;
}
