import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ErrorRecorder } from '../errorLog.js';
import { runGit, resolveCommit } from '../git/gitCli.js';

// → docs/spec/09-execution.md#worktrees

export interface Worktrees {
  ensure(branch: string, base?: string): Promise<string>;
  ensureReadOnly(key: string, of: string): Promise<string>;
  ensurePreview(ref: string): Promise<{ dir: string; commit: string }>;
  previewCommit(ref: string): Promise<string>;
  remove(branch: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
}

export class WorktreeManager implements Worktrees {
  private readonly leases = new Map<string, string>();

  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
    private readonly pool: {
      readonly size: number;
      held: (branch: string) => boolean;
    },
    private readonly previewRoot: string,
    private readonly errors?: ErrorRecorder,
  ) {}

  ensure(branch: string, base?: string): Promise<string> {
    return this.acquire({ readOnly: false, name: branch, base });
  }

  ensureReadOnly(key: string, of: string): Promise<string> {
    return this.acquire({ readOnly: true, name: key, of });
  }

  previewCommit(ref: string): Promise<string> {
    return this.startPoint('the local run', ref);
  }

  async ensurePreview(ref: string): Promise<{ dir: string; commit: string }> {
    const commit = await this.startPoint('the local run', ref);
    const dir = resolve(this.previewRoot);
    // TECHDEBT: whether the directory is there, never whether `git worktree list` names it: git
    // reports the canonical path, and a short-name TEMP root on Windows resolves
    // differently for the same directory than `worktree add` would report it as existing.
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      await this.git(['worktree', 'add', '--detach', dir, commit]);
      return { dir, commit };
    }
    await runGit(dir, ['checkout', '--quiet', '--detach']);
    await runGit(dir, ['reset', '--hard', '--quiet', commit]);
    await runGit(dir, ['clean', '-fd']);
    return { dir, commit };
  }

  private async acquire(req: Request, salvaged?: SalvageReport): Promise<string> {
    await this.git(['worktree', 'prune']).catch(() => {});

    if (!req.readOnly) {
      const existing = await this.findExistingSlot(req.name);
      if (existing) return this.lease(req.name, existing);
      const outside = await this.findExisting(req.name);
      if (outside !== null) throw new Error(this.checkedOutElsewhere(req.name, outside));
    }

    mkdirSync(this.worktreeRoot, { recursive: true });
    const slots = await this.slots();
    const survey = await this.survey(slots, req);
    if (survey.own !== null) return this.lease(req.name, survey.own);
    const take = survey.warm ?? survey.spare;
    if (take !== null) {
      await this.handOver(take, req);
      return this.lease(req.name, take);
    }

    const minted = this.nextSlotPath(slots);
    if (minted !== null) {
      await this.reclaim(minted);
      await this.create(minted, req);
      return this.lease(req.name, minted);
    }

    if (survey.evictable !== null) {
      await this.handOver(survey.evictable, req);
      return this.lease(req.name, survey.evictable);
    }

    const report = salvaged ?? (await this.salvage(survey.blocked));
    if (salvaged === undefined && report.freed > 0) return this.acquire(req, report);
    throw new Error(this.exhausted(req, survey.blocked, report, slots));
  }

  async findExisting(branch: string): Promise<string | null> {
    const entries = await this.registered();
    const match = entries.find((e) => e.branch === branch || e.branch === `refs/heads/${branch}`);
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  private async findExistingSlot(branch: string): Promise<string | null> {
    const entries = await this.registered();
    const match = entries.find(
      (e) => isUnder(this.worktreeRoot, e.path) && (e.branch === branch || e.branch === `refs/heads/${branch}`),
    );
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  remove(branch: string): Promise<void> {
    this.leases.delete(branch);
    return Promise.resolve();
  }

  async deleteBranch(branch: string): Promise<void> {
    const holding = await this.findExisting(branch);
    if (holding !== null && isUnder(this.worktreeRoot, holding)) {
      const heldBy = this.leaseOn(holding) ?? (this.pool.held(branch) ? branch : null);
      if (heldBy !== null) {
        throw new Error(
          `Cannot reap ${branch}: its slot ${holding} is still held by ${heldBy}, whose process may still be ` +
            "sitting in that directory. Detaching it now would hand a live agent's tree to the next branch. " +
            'The reap is retried on the next pulse.',
        );
      }
    }
    await this.remove(branch);
    if (holding === resolve(this.repoRoot)) throw new Error(this.reapBlockedByCheckout(branch, holding));
    if (holding !== null) await runGit(holding, ['switch', '--detach']);
    if (!(await this.branchExists(branch))) return;
    await this.git(['branch', '-D', branch]);
  }

  private lease(branch: string, dir: string): string {
    this.leases.set(branch, dir);
    return dir;
  }

  private async survey(slots: WorktreeEntry[], req: Request): Promise<Survey> {
    const blocked: Blocked[] = [];
    let warm: string | null = null;
    let spare: string | null = null;
    let evictable: string | null = null;
    for (const slot of slots) {
      const mark = readMark(this.markPath(slot.path));
      const holder = this.holder(slot, mark);
      if (holder !== null) {
        if (holder === req.name) return { own: slot.path, warm, spare, evictable, blocked };
        blocked.push({ path: slot.path, reason: `work in flight on ${holder}`, stuck: false });
        continue;
      }
      if (await this.dirty(slot.path)) {
        const on = shortBranch(slot.branch) ?? 'a detached HEAD';
        blocked.push({ path: slot.path, reason: `uncommitted changes on ${on}`, stuck: true });
        continue;
      }
      if (req.readOnly && mark !== null && mark.of === req.of) {
        warm ??= slot.path;
        continue;
      }
      const occupant = shortBranch(slot.branch);
      if (mark === null && (occupant === null || !(await this.branchExists(occupant)))) {
        spare ??= slot.path;
        if (!req.readOnly) return { own: null, warm, spare, evictable, blocked };
        continue;
      }
      evictable ??= slot.path;
    }
    return { own: null, warm, spare, evictable, blocked };
  }

  private holder(slot: WorktreeEntry, mark: Mark | null): string | null {
    const leased = this.leaseOn(slot.path);
    if (leased !== null) return leased;
    const occupant = shortBranch(slot.branch);
    if (occupant !== null && this.pool.held(occupant)) return occupant;
    if (mark !== null && this.pool.held(mark.key)) return mark.key;
    return null;
  }

  private leaseOn(dir: string): string | null {
    for (const [branch, held] of this.leases) if (held === dir) return branch;
    return null;
  }

  private async dirty(dir: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(dir, ['status', '--porcelain', '--untracked-files=no']);
      return stdout.trim() !== '';
    } catch {
      return true;
    }
  }

  private async salvage(blocked: Blocked[]): Promise<SalvageReport> {
    const notes: string[] = [];
    let freed = 0;
    for (const slot of blocked) {
      if (!slot.stuck) continue;
      try {
        const ref = await this.stash(slot.path);
        freed += 1;
        notes.push(ref === null ? `${slot.path} (nothing left to save)` : `${slot.path} → ${ref}`);
        if (ref !== null) this.errors?.record({ source: 'cycle', message: salvaged(slot.path, ref) });
      } catch (err) {
        const message = `Cannot reclaim the worktree slot ${slot.path}: ${(err as Error).message}`;
        notes.push(message);
        this.errors?.record({ source: 'cycle', message });
      }
    }
    return { freed, notes };
  }

  private async stash(dir: string): Promise<string | null> {
    const before = await this.stashTip();
    await runGit(dir, ['stash', 'push', '--include-untracked', '--message', `lubbdubb: reclaimed ${basename(dir)}`]);
    const tip = await this.stashTip();
    if (tip === null || tip === before) return null;
    const ref = `${SALVAGE_REFS}/${basename(dir)}/${tip.slice(0, 12)}`;
    await this.git(['update-ref', ref, tip]);
    if ((await this.stashTip()) === tip) await this.git(['stash', 'drop']);
    return ref;
  }

  private async stashTip(): Promise<string | null> {
    try {
      const { stdout } = await this.git(['rev-parse', '--verify', '--quiet', 'refs/stash']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async handOver(dir: string, req: Request): Promise<void> {
    const mark = readMark(this.markPath(dir));
    const warm = req.readOnly && mark !== null && mark.of === req.of;
    const onto = await this.switchOnto(req);
    this.mark(dir, null);
    try {
      await runGit(dir, ['clean', warm ? '-ffd' : '-ffdx']);
      await runGit(dir, onto);
    } catch (err) {
      throw new Error(`Cannot hand worktree slot ${dir} to ${describe(req)}: ${(err as Error).message}`);
    }
    if (req.readOnly) this.mark(dir, { key: req.name, of: req.of });
  }

  private async create(dir: string, req: Request): Promise<void> {
    this.mark(dir, null);
    if (req.readOnly) {
      await this.git(['worktree', 'add', '--detach', dir, await this.startPoint(req.name, req.of)]);
      this.mark(dir, { key: req.name, of: req.of });
      return;
    }
    if (await this.branchExists(req.name)) {
      await this.git(['worktree', 'add', dir, req.name]);
      return;
    }
    await this.git(['worktree', 'add', '-b', req.name, dir, await this.startPoint(req.name, req.base)]);
  }

  private async switchOnto(req: Request): Promise<string[]> {
    if (req.readOnly) return ['switch', '--quiet', '--detach', await this.startPoint(req.name, req.of)];
    if (await this.branchExists(req.name)) return ['switch', '--quiet', req.name];
    return ['switch', '--quiet', '-c', req.name, await this.startPoint(req.name, req.base)];
  }

  private async startPoint(name: string, base?: string): Promise<string> {
    if (base === undefined) {
      const { stdout } = await this.git(['rev-parse', 'HEAD']);
      return stdout.trim();
    }
    const startPoint = await resolveCommit(this.repoRoot, base);
    if (!startPoint)
      throw new Error(
        `Cannot prepare a worktree for ${name}: base '${base}' resolves to no commit in ${this.repoRoot}.`,
      );
    return startPoint;
  }

  private mark(dir: string, mark: Mark | null): void {
    const path = this.markPath(dir);
    if (mark === null) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(mark));
  }

  private markPath(dir: string): string {
    return resolve(this.worktreeRoot, MARKS_DIR, basename(dir));
  }

  private async slots(): Promise<WorktreeEntry[]> {
    const entries = await this.registered();
    return entries.filter((e) => isUnder(this.worktreeRoot, e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  private nextSlotPath(slots: WorktreeEntry[]): string | null {
    if (slots.length >= this.pool.size) return null;
    const taken = new Set(slots.map((e) => e.path));
    for (let i = 0; i < this.pool.size; i += 1) {
      const dir = resolve(this.worktreeRoot, slotDirName(i));
      if (!taken.has(dir)) return dir;
    }
    return null;
  }

  private checkedOutElsewhere(branch: string, path: string): string {
    return (
      `Cannot lease a worktree for ${branch}: it is already checked out at ${path}, which is not a pool slot ` +
      `(the pool is ${this.worktreeRoot}). Git refuses to check one branch out twice, and this checkout is not ` +
      `the harness's to switch — it is most likely the repository's own working copy. Switch it to another ` +
      `branch and the dispatch goes through on the next pulse.`
    );
  }

  private reapBlockedByCheckout(branch: string, path: string): string {
    return (
      `Cannot reap ${branch}: it is checked out at ${path}, the repository's own working copy, which is not ` +
      `the harness's to switch — detaching it would move an operator off their branch without asking. Git ` +
      `refuses to delete a branch that is checked out, so the local ref and the remote copy both stay. Switch ` +
      `that checkout to another branch and the reap completes on the next pulse.`
    );
  }

  private exhausted(req: Request, blocked: Blocked[], salvage: SalvageReport, slots: WorktreeEntry[]): string {
    const strays = this.strays(slots);
    return (
      `No free worktree slot for ${describe(req)}: all ${this.pool.size} slots under ${this.worktreeRoot} are ` +
      `unavailable — ${blocked.map((b) => `${b.path} (${b.reason})`).join('; ')}. ` +
      (salvage.notes.length > 0 ? `Reclaim: ${salvage.notes.join('; ')}. ` : '') +
      'A slot is held while the harness has work in flight on the branch checked out in it, and a slot carrying ' +
      'uncommitted changes is stashed onto a salvage ref and reclaimed — so one still named above is one the ' +
      'stash itself refused. The bound follows the live agent cap, so raising the cap raises it too; the ' +
      'dispatch is retried next cycle either way.' +
      (strays.length === 0
        ? ''
        : ` Costing disk but not slots: ${strays.length} ${strays.length === 1 ? 'directory' : 'directories'} ` +
          `under ${this.worktreeRoot} that git no longer knows about (${listed(strays)}). \`git worktree prune\` ` +
          'has already run, so nothing here will ever reach them again and they are safe to delete by hand; ' +
          'the harness will not, because this root is an operator setting and an unguarded delete under a ' +
          'mistyped one is unrecoverable.')
    );
  }

  private strays(slots: WorktreeEntry[]): string[] {
    const known = new Set(slots.map((e) => e.path));
    return readdirSync(this.worktreeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== MARKS_DIR)
      .map((e) => resolve(this.worktreeRoot, e.name))
      .filter((path) => !known.has(path));
  }

  private async reclaim(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await this.registered();
    if (entries.some((e) => e.path === dir)) return;
    await this.git(['worktree', 'remove', '--force', dir]).catch(() => {});
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: RMDIR_RETRIES, retryDelay: RMDIR_RETRY_DELAY_MS });
    } catch (err) {
      throw new Error(reclaimFailure(dir, err as NodeJS.ErrnoException));
    }
  }

  private async registered(): Promise<WorktreeEntry[]> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout).map((e) => ({ ...e, path: resolve(e.path) }));
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runGit(this.repoRoot, args);
  }
}

export function slotDirName(index: number): string {
  return `slot-${index}`;
}

const POOL_SLACK = 2;

export function defaultPoolSize(cap: number): number {
  return Math.max(1, cap) + POOL_SLACK;
}

const RMDIR_RETRIES = 5;
const RMDIR_RETRY_DELAY_MS = 200;

function reclaimFailure(dir: string, err: NodeJS.ErrnoException): string {
  const held = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY';
  if (!held) return `Cannot reclaim the worktree directory ${dir}: ${err.message}`;
  return (
    `Cannot reclaim the worktree directory ${dir}: it is held open by another process (${err.code}), ` +
    `and was still held after ${RMDIR_RETRIES} retries over ` +
    `${(RMDIR_RETRIES * RMDIR_RETRY_DELAY_MS) / 1000}s. That is almost always a process an earlier agent ` +
    `started and left running — a shell, a watcher, a test runner — whose working directory is still ` +
    `inside it; on Windows being a live process's cwd is by itself enough to refuse the removal. ` +
    `Stop that process and the branch dispatches again on the next cycle; until then every dispatch ` +
    `onto it will fail here.`
  );
}

type Request = { readOnly: false; name: string; base?: string } | { readOnly: true; name: string; of: string };

interface Mark {
  key: string;
  of: string;
}

const MARKS_DIR = '.read-only';

function readMark(path: string): Mark | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { key, of } = parsed as Partial<Mark>;
    return typeof key === 'string' && typeof of === 'string' ? { key, of } : null;
  } catch {
    return null;
  }
}

function describe(req: Request): string {
  return req.readOnly ? `read-only checkout ${req.name} of ${req.of}` : `branch ${req.name}`;
}

interface Survey {
  own: string | null;
  warm: string | null;
  spare: string | null;
  evictable: string | null;
  blocked: Blocked[];
}

interface Blocked {
  path: string;
  reason: string;
  stuck: boolean;
}

interface SalvageReport {
  freed: number;
  notes: string[];
}

const SALVAGE_REFS = 'refs/lubbdubb/salvage';

function salvaged(dir: string, ref: string): string {
  return (
    `Reclaimed worktree slot ${dir}, which was stranded carrying uncommitted changes. Nothing was discarded: ` +
    `its tracked edits, staged state and new files are stashed at ${ref} (\`git stash apply ${ref}\`). Ignored ` +
    'files are not stashed — a dependency tree does not belong in a git object, and the slot handles its own ' +
    "under the pool's usual rules. A slot needing this after every dispatch is a repository with tracked files " +
    'a build rewrites: untracking those is the fix, and until then this is where each copy goes.'
  );
}

function listed(paths: string[]): string {
  const named = paths.slice(0, STRAYS_NAMED);
  const rest = paths.length - named.length;
  return rest === 0 ? named.join(', ') : `${named.join(', ')}, and ${rest} more`;
}

const STRAYS_NAMED = 5;

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

function shortBranch(ref: string | null): string | null {
  if (ref === null) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '') {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}
