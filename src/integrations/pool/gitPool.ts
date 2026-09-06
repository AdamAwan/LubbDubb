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

/**
 * The pool on a git repository: clone, pull, write your own file under the
 * configured prefix, push. Provider-neutral by construction, so one implementation
 * covers Azure DevOps, GitHub and any bare repository.
 *
 * Its clone lives under its own root and never under `worktreeRoot` — the worktree
 * pool counts every registered worktree under that root as a slot, so a clone in
 * there would be leased to an agent and wiped with `git clean -ffdx`.
 * → `docs/spec/09-execution.md#exhaustion`, `docs/spec/23-local-runs.md#the-checkout`
 *
 * The repository need not be the pool's; the rules that follow from that are on
 * {@link publish} and {@link fetch}. → `docs/spec/28-cross-fleet-pool.md#living-in-somebody-elses-repository`
 */
export class GitPoolTransport implements PoolTransport {
  readonly id = 'pool:git';
  readonly canRead = true;

  constructor(
    private readonly deps: {
      /** The pool clone's own root. Never under `worktreeRoot` — see the class note. */
      root: string;
      remote: string;
      branch: string;
      /** The prefix inside the repository, or `''` for its root. Checked at config load. */
      path: string;
      fleetId: string;
      /** How many times a rejected push is pulled and retried. Bounded, and never forced. */
      pushRetries?: number;
    },
  ) {}

  /**
   * Write this fleet's document and push it. The write set is exactly
   * `<path>/fleets/<fleetId>/`, staged by name — never `git add -A`, never `git add
   * .`, never `git clean` anywhere in the clone, which in a shared wiki would commit
   * whatever else is in the tree.
   *
   * A rejected push is pulled and retried, never forced: one writer per namespace
   * makes the rebase conflict-free by construction; retries are bounded and a
   * persistent rejection is thrown for the desk to record.
   */
  async publish(document: PoolDocument): Promise<void> {
    await this.ensureClone();
    // The document and its companion, committed as one. The markdown is derived and
    // never read back, so it cannot become a second grammar for one fact.
    // → `docs/spec/28-cross-fleet-pool.md#the-human-readable-companion`
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

  /**
   * Clear what a retired kind left in this fleet's own namespace, and hand back the
   * paths so the publish's own commit records the removal. Only paths that are
   * actually there — `git add` on a path that never existed is a fatal pathspec
   * error. Its own namespace and no other. → `docs/spec/28-cross-fleet-pool.md#what-a-retired-kind-leaves-behind`
   */
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

  /**
   * Remove this fleet's shared pack for a pull request, and its companion — the
   * same write-set rule as {@link publish}, staged by name. Removing what is not
   * there is a success, so a prune is as retryable as a put. → `docs/spec/31-review-packs.md#sharing-a-pack`
   */
  async unpublish(pack: PoolPackRef): Promise<void> {
    await this.ensureClone();
    const paths = [
      this.prefixed(poolPackPath(pack.fleetId, pack.prNumber)),
      this.prefixed(reviewPackCompanionPath(pack.fleetId, pack.prNumber)),
    ];
    for (const relative of paths) {
      // Unlinked rather than `git rm`, so a file already gone is not an error and
      // the staging below is the one place that decides whether anything changed.
      try {
        unlinkSync(join(this.deps.root, ...relative.split('/')));
      } catch {
        /* already gone: a prune that has run before, or a pack that never landed */
      }
    }
    await this.commit(paths, `pool: ${this.deps.fleetId} pack #${pack.prNumber} pruned`);
  }

  /**
   * Stage exactly these paths, commit if anything moved, and push. By name, and
   * only these — never `git add -A`, `git add .`, or `git clean` anywhere in the
   * clone. Nothing staged means the repository already holds what was meant.
   */
  private async commit(paths: string[], message: string): Promise<void> {
    await runGit(this.deps.root, ['add', '--', ...paths]);
    const staged = await runGit(this.deps.root, ['diff', '--cached', '--name-only', '--', ...paths]);
    if (staged.stdout.trim() === '') return;
    await runGit(this.deps.root, ['commit', '-m', message, '--', ...paths]);
    await this.push();
  }

  /** Everybody's documents, this fleet's included. The read is scoped to `<path>/fleets/` rather than the tree: a fetch that walked a shared wiki would try to parse the team's notes and record an error for each, every pulse. */
  async fetch(): Promise<PoolFetchedDocument[]> {
    await this.ensureClone();
    await runGit(this.deps.root, ['pull', '--ff-only', 'origin', this.deps.branch]);
    const fleetsDir = join(this.deps.root, ...this.prefixed('fleets').split('/'));
    const out: PoolFetchedDocument[] = [];
    for (const fleetId of listDirectories(fleetsDir)) {
      for (const kind of POOL_CLOCK_KINDS) {
        const file = join(fleetsDir, fleetId, `${kind}.json`);
        const text = readIfFile(file);
        // The directory name is the address, checked against the body's `fleetId`
        // one layer up — the one thing that can break one writer per namespace.
        if (text !== null) out.push({ addressedTo: fleetId, text });
      }
    }
    return out;
  }

  /** The configured prefix in front of a pool-relative path. Empty prefix is the repository root. */
  private prefixed(path: string): string {
    return this.deps.path === '' ? path : posix.join(this.deps.path, path);
  }

  /**
   * The clone, made once and reused. The guard must establish that the repository
   * it found is this root's own: `git rev-parse` walks up, so in the default layout
   * every pool root would read as an existing clone and publishes would commit into
   * the operator's own checkout; `--show-toplevel` compared against the root is the
   * exact question.
   *
   * Anything at the root that is not that clone is removed before cloning — a stray
   * document tree is re-derivable, and `git clone` refuses a non-empty directory.
   * → `docs/spec/28-cross-fleet-pool.md#the-clone-and-its-root`
   */
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

  /** Whether the repository `git` reports from the root is the root itself, rather than one enclosing it. */
  private async isOwnClone(): Promise<boolean> {
    try {
      const { stdout } = await runGit(this.deps.root, ['rev-parse', '--show-toplevel']);
      return samePath(stdout.trim(), this.deps.root);
    } catch {
      // No repository here at all, or no directory yet: either way, not a clone.
      return false;
    }
  }

  /**
   * The clone's `origin` is the configured remote, checked before anything is
   * written into it — a clone left by an earlier `pool.remote` passes every other
   * check and only lands the documents in the wrong repository. Refused rather than
   * re-cloned: wiping a repository on the strength of a config edit is worse.
   */
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

  /** Push, and on a rejection pull-rebase and try again. Bounded, and never `--force`. */
  private async push(): Promise<void> {
    const attempts = this.deps.pushRetries ?? 3;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await runGit(this.deps.root, ['push', 'origin', `HEAD:${this.deps.branch}`]);
        return;
      } catch (error) {
        last = error;
        // Conflict-free by construction: one writer per namespace, so incoming
        // changes cannot touch the file this fleet just wrote.
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
    // A pool nobody has published to yet has no `fleets/` at all: an empty read
    // rather than a failure recorded every pulse.
    return [];
  }
}

/** One document's bytes, or null when there is nothing readable there. Read first and ask afterwards: a stat-then-read is a check-then-use over a path other fleets and people are pushing to, and every way of not being a readable file already throws. */
function readIfFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether two paths name the same directory. Both sides go through `resolve` and
 * `realpath` because `git` answers `--show-toplevel` with symlinks resolved —
 * otherwise a root under macOS's `/var` -> `/private/var` is re-cloned every pulse.
 */
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

/**
 * Whether a clone's `origin` is the configured remote: string equality with a
 * trailing slash ignored and a local path compared as a path. Deliberately nothing
 * cleverer — a false match writes into the wrong repository.
 */
function sameRemote(origin: string, configured: string): boolean {
  const trimmed = (url: string): string => url.replace(/\/+$/, '');
  if (trimmed(origin) === trimmed(configured)) return true;
  return origin.includes('://') || configured.includes('://') ? false : samePath(origin, configured);
}
