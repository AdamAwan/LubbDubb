import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { runGit } from '../../git/gitCli.js';
import { poolCompanion } from '../../pool/companion.js';
import {
  POOL_CLOCK_KINDS,
  poolDocumentAddress,
  poolPackPath,
  poolRetiredPaths,
  serialisePoolDocument,
} from '../../pool/document.js';
import { reviewPackCompanionPath } from '../../reviewPacks/companion.js';
import type { PoolFetchedDocument, PoolPackRef, PoolTransport } from '../../pool/transport.js';
import type { PoolDocument } from '../../types.js';

// → docs/spec/15-integrations.md

export class GitPoolTransport implements PoolTransport {
  readonly id = 'pool:git';
  readonly canRead = true;

  constructor(
    private readonly deps: {
      root: string;
      remote: string;
      branch: string;
      path: string;
      fleetId: string;
      pushRetries?: number;
    },
  ) {}

  async publish(document: PoolDocument): Promise<void> {
    await this.ensureClone();
    const companion = poolCompanion(document);
    const files = [
      { relative: this.prefixed(poolDocumentAddress(document)), text: serialisePoolDocument(document) },
      { relative: this.prefixed(companion.path), text: companion.text },
    ];
    const paths = files.map((file) => file.relative);
    for (const file of files) {
      const absolute = join(this.deps.root, ...file.relative.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, file.text, 'utf8');
    }
    await this.commit([...paths, ...this.clearRetired()], `pool: ${this.deps.fleetId} ${document.kind}`);
  }

  private clearRetired(): string[] {
    const cleared: string[] = [];
    for (const relative of poolRetiredPaths(this.deps.fleetId).map((path) => this.prefixed(path))) {
      const absolute = join(this.deps.root, ...relative.split('/'));
      if (!existsSync(absolute)) continue;
      unlinkSync(absolute);
      cleared.push(relative);
    }
    return cleared;
  }

  async unpublish(pack: PoolPackRef): Promise<void> {
    await this.ensureClone();
    const paths = [
      this.prefixed(poolPackPath(pack.fleetId, pack.prNumber)),
      this.prefixed(reviewPackCompanionPath(pack.fleetId, pack.prNumber)),
    ];
    for (const relative of paths) {
      try {
        unlinkSync(join(this.deps.root, ...relative.split('/')));
      } catch {
        /* already gone: a prune that has run before, or a pack that never landed */
      }
    }
    await this.commit(paths, `pool: ${this.deps.fleetId} pack #${pack.prNumber} pruned`);
  }

  private async commit(paths: string[], message: string): Promise<void> {
    await runGit(this.deps.root, ['add', '--', ...paths]);
    const staged = await runGit(this.deps.root, ['diff', '--cached', '--name-only', '--', ...paths]);
    if (staged.stdout.trim() === '') return;
    await runGit(this.deps.root, ['commit', '-m', message, '--', ...paths]);
    await this.push();
  }

  async fetch(): Promise<PoolFetchedDocument[]> {
    await this.ensureClone();
    await runGit(this.deps.root, ['pull', '--ff-only', 'origin', this.deps.branch]);
    const fleetsDir = join(this.deps.root, ...this.prefixed('fleets').split('/'));
    const out: PoolFetchedDocument[] = [];
    for (const fleetId of listDirectories(fleetsDir)) {
      for (const kind of POOL_CLOCK_KINDS) {
        const file = join(fleetsDir, fleetId, `${kind}.json`);
        const text = readIfFile(file);
        if (text !== null) out.push({ addressedTo: fleetId, text });
      }
    }
    return out;
  }

  private prefixed(path: string): string {
    return this.deps.path === '' ? path : posix.join(this.deps.path, path);
  }

  private async ensureClone(): Promise<void> {
    if (await this.isOwnClone()) {
      await this.assertOrigin();
      return;
    }
    rmSync(this.deps.root, { recursive: true, force: true });
    mkdirSync(dirname(this.deps.root), { recursive: true });
    await runGit(dirname(this.deps.root), [
      'clone',
      '--branch',
      this.deps.branch,
      '--single-branch',
      this.deps.remote,
      this.deps.root,
    ]);
  }

  private async isOwnClone(): Promise<boolean> {
    try {
      const { stdout } = await runGit(this.deps.root, ['rev-parse', '--show-toplevel']);
      return samePath(stdout.trim(), this.deps.root);
    } catch {
      return false;
    }
  }

  private async assertOrigin(): Promise<void> {
    let origin: string | null = null;
    try {
      const { stdout } = await runGit(this.deps.root, ['remote', 'get-url', 'origin']);
      origin = stdout.trim();
    } catch {
      /* a clone with no origin at all — the same refusal, reported as none */
    }
    if (origin !== null && sameRemote(origin, this.deps.remote)) return;
    throw new Error(
      `The pool clone at ${this.deps.root} has origin ${origin ?? 'none'}, which is not the configured remote ` +
        `${this.deps.remote}. Nothing was written. Point pool.remote back at it, or delete the directory so the ` +
        `pool is cloned afresh.`,
    );
  }

  private async push(): Promise<void> {
    const attempts = this.deps.pushRetries ?? 3;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await runGit(this.deps.root, ['push', 'origin', `HEAD:${this.deps.branch}`]);
        return;
      } catch (error) {
        last = error;
        await runGit(this.deps.root, ['pull', '--rebase', 'origin', this.deps.branch]);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readIfFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const canonical = (path: string): string => {
    const absolute = resolve(path);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  };
  const [left, right] = [canonical(a), canonical(b)];
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameRemote(origin: string, configured: string): boolean {
  const trimmed = (url: string): string => url.replace(/\/+$/, '');
  if (trimmed(origin) === trimmed(configured)) return true;
  return origin.includes('://') || configured.includes('://') ? false : samePath(origin, configured);
}
