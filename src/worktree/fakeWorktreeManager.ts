import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { slotDirName, type Worktrees } from './worktreeManager.js';

// → docs/spec/09-execution.md#worktrees

interface FakeWorktreeCall {
  branch: string;
  base?: string;
  readOnly?: true;
}

export class FakeWorktreeManager implements Worktrees {
  readonly ensured: FakeWorktreeCall[] = [];
  readonly removed: string[] = [];
  readonly deleted: string[] = [];
  readonly previewed: string[] = [];
  readonly resolved: string[] = [];
  failPreview: Error | null = null;
  private readonly tips = new Map<string, string>();

  private readonly root: string;
  private readonly size: number;
  private readonly leases = new Map<string, string>();
  private readonly occupants = new Map<string, string>();
  private readonly slots: string[] = [];

  constructor(root?: string, size = DEFAULT_POOL_SIZE) {
    this.root = root ?? mkdtempSync(join(tmpdir(), 'lubbdubb-fakewt-'));
    this.size = size;
  }

  ensure(branch: string, base?: string): Promise<string> {
    this.ensured.push(base === undefined ? { branch } : { branch, base });
    return this.slotFor(branch);
  }

  ensureReadOnly(key: string, of: string): Promise<string> {
    this.ensured.push({ branch: key, base: of, readOnly: true });
    return this.slotFor(key);
  }

  ensurePreview(ref: string): Promise<{ dir: string; commit: string }> {
    this.previewed.push(ref);
    if (this.failPreview !== null) return Promise.reject(this.failPreview);
    const dir = resolve(this.root, 'preview');
    mkdirSync(dir, { recursive: true });
    return Promise.resolve({ dir, commit: this.tipOf(ref) });
  }

  previewCommit(ref: string): Promise<string> {
    this.resolved.push(ref);
    return Promise.resolve(this.tipOf(ref));
  }

  setPreviewCommit(ref: string, commit: string): this {
    this.tips.set(ref, commit);
    return this;
  }

  private tipOf(ref: string): string {
    const declared = this.tips.get(ref);
    if (declared !== undefined) return declared;
    let hash = 0;
    for (const ch of ref) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return hash.toString(16).padStart(8, '0').repeat(5);
  }

  private slotFor(branch: string): Promise<string> {
    const warm = this.leases.get(branch) ?? this.slots.find((dir) => this.occupants.get(dir) === branch);
    if (warm !== undefined) return Promise.resolve(this.lease(branch, warm));
    const spare = this.slots.find((dir) => !this.isLeased(dir) && !this.occupants.has(dir));
    if (spare !== undefined) return Promise.resolve(this.lease(branch, spare));
    if (this.slots.length < this.size) {
      const dir = resolve(this.root, slotDirName(this.slots.length));
      mkdirSync(dir, { recursive: true });
      this.slots.push(dir);
      return Promise.resolve(this.lease(branch, dir));
    }
    const evictable = this.slots.find((dir) => !this.isLeased(dir));
    if (evictable !== undefined) return Promise.resolve(this.lease(branch, evictable));
    return Promise.reject(
      new Error(`No free worktree slot for branch ${branch}: all ${this.size} slots under ${this.root} are leased.`),
    );
  }

  deleteBranch(branch: string): Promise<void> {
    this.deleted.push(branch);
    const dir = this.leases.get(branch) ?? this.slots.find((d) => this.occupants.get(d) === branch);
    if (dir !== undefined) this.occupants.delete(dir);
    return this.remove(branch);
  }

  remove(branch: string): Promise<void> {
    this.removed.push(branch);
    this.leases.delete(branch);
    return Promise.resolve();
  }

  private lease(branch: string, dir: string): string {
    this.leases.set(branch, dir);
    this.occupants.set(dir, branch);
    return dir;
  }

  private isLeased(dir: string): boolean {
    for (const held of this.leases.values()) if (held === dir) return true;
    return false;
  }
}

const DEFAULT_POOL_SIZE = 32;
