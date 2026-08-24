import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { runGit } from '../../git/gitCli.js';
import { poolDocumentPath, serialisePoolDocument } from '../../pool/document.js';
import type { PoolFetchedDocument, PoolTransport } from '../../pool/transport.js';
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
   * **The write set is exactly `<path>/fleets/<fleetId>/`.** The two files are
   * staged by name and those paths committed — never `git add -A`, never `git add
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
    const relative = this.prefixed(poolDocumentPath(this.deps.fleetId, document.kind));
    const absolute = join(this.deps.root, ...relative.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, serialisePoolDocument(document), 'utf8');
    // By name, and only this one. See the class note.
    await runGit(this.deps.root, ['add', '--', relative]);
    const staged = await runGit(this.deps.root, ['diff', '--cached', '--name-only', '--', relative]);
    // Nothing staged means the bytes are already what the repository holds — which
    // the content hash upstream should have caught, and which an empty commit is
    // never the right answer to.
    if (staged.stdout.trim() === '') return;
    await runGit(this.deps.root, ['commit', '-m', `pool: ${this.deps.fleetId} ${document.kind}`, '--', relative]);
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
   * `git rev-parse --git-dir` rather than a directory check: the root may exist and
   * be empty (a mkdir from a failed earlier attempt), and cloning into a directory
   * that is already a repository is the failure mode that would strand a pool.
   */
  private async ensureClone(): Promise<void> {
    mkdirSync(this.deps.root, { recursive: true });
    try {
      await runGit(this.deps.root, ['rev-parse', '--git-dir']);
      return;
    } catch {
      /* not a clone yet */
    }
    await runGit(this.deps.root, [
      'clone',
      '--branch',
      this.deps.branch,
      '--single-branch',
      this.deps.remote,
      this.deps.root,
    ]);
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
