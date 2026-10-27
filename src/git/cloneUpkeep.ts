import type { ErrorRecorder } from '../errorLog.js';
import type { Agent } from '../types.js';
import { runGit, takeReaps } from './gitCli.js';
import { clearOrphans, commonGitDir, readPackStore, type OrphanSweep, type PackStore } from './packStore.js';

// → docs/spec/09-execution.md#the-clones-object-store

export interface CloneKeeper {
  readonly gitDir: string | null;
  /** Above this many packs, an idle fleet repacks. */
  readonly packLimit: number;
  read(): PackStore | null;
  partialFilter(): Promise<string | null>;
  clearOrphans(): Promise<OrphanSweep>;
  repack(): Promise<void>;
}

export interface CloneStanding {
  gitDir: string;
  packs: number;
  bytes: number;
  packLimit: number;
  partial: { filter: string | null } | null;
  readAt: string;
  repack: { at: string; ok: boolean; packsBefore: number; packsAfter: number | null; detail: string | null } | null;
  repacking: boolean;
}

const REPACK_PACK_LIMIT = 100;
const READ_EVERY_MS = 60_000;
const REPACK_COOLDOWN_MS = 60 * 60_000;
const REPACK_TIMEOUT_MS = 2 * 60 * 60_000;
const BUSY: ReadonlySet<Agent['status']> = new Set(['starting', 'running']);

export class GitCloneKeeper implements CloneKeeper {
  readonly gitDir: string | null;

  constructor(
    private readonly repoRoot: string,
    readonly packLimit = REPACK_PACK_LIMIT,
  ) {
    this.gitDir = commonGitDir(repoRoot);
  }

  read(): PackStore | null {
    return this.gitDir === null ? null : readPackStore(this.gitDir);
  }

  async partialFilter(): Promise<string | null> {
    try {
      const { stdout } = await runGit(this.repoRoot, ['config', '--get-regexp', '^remote\\..*\\.partialclonefilter$'], {
        noLazyFetch: true,
      });
      return stdout.trim().split(/\s+/)[1] ?? null;
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return null;
      throw err;
    }
  }

  clearOrphans(): Promise<OrphanSweep> {
    return this.gitDir === null ? Promise.resolve({ keeps: [], tmpFiles: [] }) : clearOrphans(this.gitDir);
  }

  async repack(): Promise<void> {
    await runGit(this.repoRoot, ['repack', '-A', '-d', '-q'], { timeoutMs: REPACK_TIMEOUT_MS });
  }
}

export class CloneUpkeepDesk {
  private standingNow: CloneStanding | null = null;
  private lastReadMs = Number.NEGATIVE_INFINITY;
  private lastRepackMs = Number.NEGATIVE_INFINITY;
  private repacking: Promise<void> | null = null;
  private partial: CloneStanding['partial'] | undefined;

  constructor(
    private readonly deps: {
      keeper: CloneKeeper;
      errors: ErrorRecorder;
      now?: () => number;
    },
  ) {}

  standing(): CloneStanding | null {
    return this.standingNow === null ? null : { ...this.standingNow, repacking: this.repacking !== null };
  }

  async run(at: { agents: Agent[] }): Promise<void> {
    const { keeper } = this.deps;
    if (keeper.gitDir === null) return;
    this.recordReaps(keeper.gitDir);
    const now = this.now();
    if (now - this.lastReadMs < READ_EVERY_MS) return;
    this.lastReadMs = now;

    const swept = await keeper.clearOrphans();
    if (swept.keeps.length + swept.tmpFiles.length > 0)
      this.deps.errors.record({
        source: 'cycle',
        message: `Cleared ${swept.keeps.length} stale .keep and ${swept.tmpFiles.length} abandoned tmp_pack file(s) from ${keeper.gitDir}, left by git processes that died mid-fetch.`,
        detail: [...swept.keeps, ...swept.tmpFiles].join('\n'),
      });

    const store = keeper.read();
    if (store === null) return;
    const partial = store.promisorPacks > 0 ? await this.partialClone(keeper) : null;
    this.standingNow = {
      gitDir: keeper.gitDir,
      packs: store.packs,
      bytes: store.bytes,
      packLimit: keeper.packLimit,
      partial,
      readAt: new Date(now).toISOString(),
      repack: this.standingNow?.repack ?? null,
      repacking: false,
    };

    if (this.repacking !== null) return;
    if (store.packs <= keeper.packLimit) return;
    if (at.agents.some((a) => BUSY.has(a.status))) return;
    if (now - this.lastRepackMs < REPACK_COOLDOWN_MS) return;
    this.lastRepackMs = now;
    this.repacking = this.repack(store.packs);
  }

  /** Settles when a repack this desk started has finished; for tests and shutdown. */
  async idle(): Promise<void> {
    await this.repacking;
  }

  private async repack(packsBefore: number): Promise<void> {
    const at = new Date(this.now()).toISOString();
    let ok = true;
    let detail: string | null = null;
    try {
      await this.deps.keeper.repack();
    } catch (err) {
      ok = false;
      detail = (err as Error).message;
      this.deps.errors.record({
        source: 'cycle',
        message: `Repacking the clone's ${packsBefore} packs failed; it is retried in an hour if the fleet is idle.`,
        detail,
      });
    }
    const after = this.deps.keeper.read();
    this.repacking = null;
    if (this.standingNow !== null)
      this.standingNow = {
        ...this.standingNow,
        packs: after?.packs ?? this.standingNow.packs,
        bytes: after?.bytes ?? this.standingNow.bytes,
        repack: { at, ok, packsBefore, packsAfter: after?.packs ?? null, detail },
      };
  }

  private recordReaps(gitDir: string): void {
    for (const reap of takeReaps(gitDir)) {
      const left = [...reap.swept.keeps, ...reap.swept.tmpFiles];
      this.deps.errors.record({
        source: 'cycle',
        message:
          `${reap.command} was killed (${reap.reason}); ` +
          (left.length === 0
            ? 'it left nothing behind in the pack directory.'
            : `removed ${reap.swept.keeps.length} .keep and ${reap.swept.tmpFiles.length} tmp_pack file(s) it left behind.`),
        detail: left.length === 0 ? null : left.join('\n'),
      });
    }
  }

  private async partialClone(keeper: CloneKeeper): Promise<NonNullable<CloneStanding['partial']>> {
    if (this.partial) return this.partial;
    let filter: string | null = null;
    try {
      filter = await keeper.partialFilter();
    } catch (err) {
      this.deps.errors.record({
        source: 'cycle',
        message: `Could not read the partial-clone filter of ${keeper.gitDir}`,
        detail: (err as Error).message,
      });
    }
    const partial = { filter };
    this.partial = partial;
    this.deps.errors.record({
      source: 'cycle',
      message: `The project clone at ${keeper.gitDir} is a partial clone (${partial.filter ?? 'promisor remote'}). Any git that touches an object it lacks fetches it on demand, often with its whole history; convert it to a full clone.`,
    });
    return partial;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
