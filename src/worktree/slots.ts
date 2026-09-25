import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

// → docs/spec/09-execution.md#worktrees

export type Request = { readOnly: false; name: string; base?: string } | { readOnly: true; name: string; of: string };

export interface Mark {
  key: string;
  of: string;
}

export const MARKS_DIR = '.read-only';

export function readMark(path: string): Mark | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { key, of } = parsed as Partial<Mark>;
    return typeof key === 'string' && typeof of === 'string' ? { key, of } : null;
  } catch {
    return null;
  }
}

export function describe(req: Request): string {
  return req.readOnly ? `read-only checkout ${req.name} of ${req.of}` : `branch ${req.name}`;
}

export interface Survey {
  own: string | null;
  warm: string | null;
  spare: string | null;
  evictable: string | null;
  blocked: Blocked[];
}

export interface Blocked {
  path: string;
  reason: string;
  stuck: boolean;
}

export interface SalvageReport {
  freed: number;
  notes: string[];
}

export interface Condemnation {
  /** The short form, for the slot's line in the exhaustion refusal. */
  reason: string;
  /**
   * Files whose presence is the condemnation, observed rather than predicted: while one is there
   * the wipe the revival performs answers a question this slot is not failing on.
   */
  blockers?: string[];
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export function shortBranch(ref: string | null): string | null {
  if (ref === null) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
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
