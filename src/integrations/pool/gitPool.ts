import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { runGit } from '../../git/gitCli.js';
import { poolCompanion } from '../../pool/companion.js';
import { poolDocumentAddress, poolPackPath, serialisePoolDocument } from '../../pool/document.js';
import { reviewPackCompanionPath } from '../../reviewPacks/companion.js';
import type { PoolFetchedDocument, PoolPackRef, PoolTransport } from '../../pool/transport.js';
import type { PoolDocument } from '../../types.js';

/**
 * The pool on a git repository: clone, pull, write your own file under the
 * configured prefix, push.
 *
 * **Provider-neutral by construction**, which is the whole reason it is the only
 * real transport worth writing first: one implementation covers Azure DevOps with a
 * wiki, Azure DevOps without one, GitHub, and any bare repository — and, because
 * the prefix means the repository need not be the pool's, a folder inside a team's
 * existing wiki is a first-class home rather than a workaround. A provider-specific
 * wiki transport is an optional extra that may never be worth writing; an `http`
 * service later is one factory line with nothing above it changing.
 *
 * **Its clone lives under its own root and never under `worktreeRoot`.** The
 * worktree pool counts every registered worktree under that root as a slot whatever
 * the directory is called, so a pool clone in there would be leased to an agent and
 * wiped with `git clean -ffdx`. Exactly the hazard `localRunRoot` exists to avoid,
 * and the same answer: a separate root, touched by nothing else.
 * → `docs/spec/09-execution.md#exhaustion`, `docs/spec/23-local-runs.md#the-checkout`
 *
 * Three rules follow from the repository not being the pool's, and each of them is
 * a way to damage somebody else's work — see {@link publish} and {@link fetch}.
 *
 * → `docs/spec/28-cross-fleet-pool.md#living-in-somebody-elses-repository`
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
   * Write this fleet's document and push it.
   *
   * **The write set is exactly `<path>/fleets/<fleetId>/`.** Each file is staged
   * by name and those paths committed — never `git add -A`, never `git add
   * .`, and never `git clean` anywhere in the clone. In a dedicated repository a
   * broad stage is untidy; in a wiki it commits whatever else happens to be in the
   * tree, under the harness's name, on a schedule, with nobody having asked.
   *
   * **A rejected push is pulled and retried, never forced.** Other fleets push here
   * and, in a shared repository, so do people; `--force` on somebody's wiki is the
   * worst outcome this design can produce. The rebase is safe by construction rather
   * than by luck — one writer per namespace means the incoming changes cannot touch
   * the file this fleet is writing, so there is nothing for a rebase to conflict
   * over. Retries are bounded, and a push that keeps being rejected is thrown for
   * the desk to record and left for the next pulse like any other failure.
   */
  async publish(document: PoolDocument): Promise<void> {
    await this.ensureClone();
    // The document and its companion, written together and committed as one. The
    // markdown is derived from the same document and never read back — `fetch`
    // names the `.json` by name — so it cannot become a second grammar for one
    // fact. → `docs/spec/28-cross-fleet-pool.md#the-human-readable-companion`
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
    await this.commit(paths, `pool: ${this.deps.fleetId} ${document.kind}`);
  }

  /**
   * Remove this fleet's shared pack for a pull request, and its companion.
   *
   * The same write set rule as {@link publish}, one level narrower: two paths
   * inside this fleet's own directory, staged by name, and a commit that names
   * only them. Removing what is not there is a success — the commit finds nothing
   * staged and returns — because a prune is the inverse of a whole-document put
   * and must be as retryable as one.
   * → `docs/spec/31-review-packs.md#sharing-a-pack`
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
   * Stage exactly these paths, commit if anything moved, and push.
   *
   * **By name, and only these.** Never `git add -A`, never `git add .`, and never
   * `git clean` anywhere in the clone — see the class note. `git add` on a path
   * that is gone records the removal, which is what makes a prune the same two
   * commands as a publish. Nothing staged means the repository already holds what
   * this fleet meant to write, and an empty commit is never the right answer to that.
   */
  private async commit(paths: string[], message: string): Promise<void> {
    await runGit(this.deps.root, ['add', '--', ...paths]);
    const staged = await runGit(this.deps.root, ['diff', '--cached', '--name-only', '--', ...paths]);
    if (staged.stdout.trim() === '') return;
    await runGit(this.deps.root, ['commit', '-m', message, '--', ...paths]);
    await this.push();
  }

  /**
   * Everybody's documents, this fleet's included.
   *
   * **The read is scoped to `<path>/fleets/`** rather than to the tree. A pool
   * sharing a wiki is a pool whose sibling directories are full of documents that
   * are not documents in this sense, and a fetch that walked the repository would
   * try to parse the team's meeting notes and record an error for each one, every
   * pulse.
   */
  async fetch(): Promise<PoolFetchedDocument[]> {
    await this.ensureClone();
    await runGit(this.deps.root, ['pull', '--ff-only', 'origin', this.deps.branch]);
    const fleetsDir = join(this.deps.root, ...this.prefixed('fleets').split('/'));
    const out: PoolFetchedDocument[] = [];
    for (const fleetId of listDirectories(fleetsDir)) {
      for (const kind of ['claims', 'digest'] as const) {
        const file = join(fleetsDir, fleetId, `${kind}.json`);
        const text = readIfFile(file);
        // The directory name is the address, which is what the body's `fleetId` is
        // checked against one layer up: a document under `alice@api/` naming
        // `bob@api` is the one thing that can break one writer per namespace.
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
   * The clone, made once and reused.
   *
   * **The guard must establish that the repository it found is _this root's own_.**
   * `git rev-parse --git-dir` walks *up* the directory tree, so in the default
   * configuration — `poolRoot` is `<deskRoot>/pool` and `deskRoot` resolves against
   * `repoRoot` — it reports the **target repository's** git dir and every pool root
   * reads as an existing clone. Nothing is ever cloned, and `publish` then writes
   * its document into a plain directory inside the operator's checkout and stages it
   * there. Where that path happens to be ignored the `git add` fails loudly; where it
   * does not, the harness commits a pool document into somebody's repository under
   * their name, on a schedule, with nobody having asked. `--show-toplevel` compared
   * against the root is the exact question, and the walk stops mattering.
   *
   * Still not a plain directory check, for the reason it never was: the root may
   * exist and be empty from a failed earlier attempt, and cloning into a directory
   * that is already a repository is the failure mode that would strand a pool.
   *
   * **Anything at the root that is not that clone is removed before cloning.** The
   * root is the transport's alone, so what is there is either nothing, or the stray
   * document tree an affected deployment's earlier publishes wrote — and a stray
   * document is re-derivable by construction, since the put is a whole replace. It
   * is also what makes the recovery automatic: `git clone` refuses a non-empty
   * directory, so a deployment that has already hit this would otherwise fail
   * forever on a directory only an operator could clear.
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
   * written into it.
   *
   * A clone left behind by an earlier `pool.remote` is a real repository at the
   * right path, so every check above it passes and the only thing wrong is *which*
   * repository the fleet's documents, commits and pushes land in. Refused rather
   * than re-cloned: wiping a repository on the strength of a config edit is the more
   * expensive way to be wrong, and the throw is recorded by the desk like any other
   * pool failure and names both URLs.
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
        // Safe by construction rather than by luck: one writer per namespace means
        // the incoming changes cannot touch the file this fleet just wrote.
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
    // A pool nobody has published to yet has no `fleets/` at all, which is an empty
    // read rather than a failure — and the difference matters: a throw here would be
    // recorded every pulse for a pool that is simply new.
    return [];
  }
}

/**
 * One document's bytes, or null when there is nothing readable there.
 *
 * **Read first and ask afterwards**, rather than `statSync().isFile()` and then a
 * read. The pair is a check-then-use over a path other fleets and people are
 * pushing to: the file can be replaced by a directory — or vanish — between the two
 * calls, so the stat answers about one thing and the read touches another. Reading
 * straight through has no window at all, and it costs nothing here because every
 * way of not being a readable file already throws: `ENOENT` for a document that is
 * not there, `EISDIR` for a directory wearing a document's name.
 */
function readIfFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether two paths name the same directory. `git` answers `--show-toplevel` with
 * forward slashes on every platform and with symlinks resolved, so both sides are
 * put through `resolve` and `realpath` before they are compared — otherwise a root
 * under macOS's `/var` -> `/private/var` reads as somebody else's repository and is
 * re-cloned on every pulse.
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
 * Whether a clone's `origin` is the configured remote. String equality over the URL
 * as both sides spell it, with a trailing slash ignored and a local path compared as
 * a path — deliberately nothing cleverer, because the cost of a false *match* is
 * writing into the wrong repository and the cost of a false mismatch is a recorded
 * error naming both URLs.
 */
function sameRemote(origin: string, configured: string): boolean {
  const trimmed = (url: string): string => url.replace(/\/+$/, '');
  if (trimmed(origin) === trimmed(configured)) return true;
  return origin.includes('://') || configured.includes('://') ? false : samePath(origin, configured);
}
