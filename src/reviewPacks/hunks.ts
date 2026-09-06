import type { ReviewRange } from '../types.js';

// → docs/spec/31-review-packs.md

export interface DiffHunk {
  id: string;
  range: ReviewRange;
  code: string[];
  added: number;
  removed: number;
}

export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  let current: DiffHunk | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      path = null;
      continue;
    }
    if (current !== null && /^[-+ \\]/.test(line)) {
      if (line.startsWith('+')) current.added += 1;
      else if (line.startsWith('-')) current.removed += 1;
      current.code.push(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      const old = stripPathPrefix(line.slice(4));
      if (path === null && old !== null) path = old;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const fresh = stripPathPrefix(line.slice(4));
      if (fresh !== null) path = fresh;
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      current = {
        id: `h${hunks.length + 1}`,
        range: {
          path: path ?? '',
          start: Math.max(start, 1),
          end: count === 0 ? Math.max(start, 1) : start + count - 1,
        },
        code: [],
        added: 0,
        removed: 0,
      };
      hunks.push(current);
      continue;
    }
    current = null;
  }
  return hunks;
}

function stripPathPrefix(raw: string): string | null {
  const name = raw.replace(/\t.*$/, '');
  if (name === '/dev/null') return null;
  return name.replace(/^[ab]\//, '');
}

export const PLUMBING_IDEA_ID = 'plumbing';

function isTestPath(path: string): boolean {
  return /(^|\/)tests?\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export function testsOnlyIdea(hunks: readonly DiffHunk[], hunkIds: readonly string[]): boolean {
  if (hunkIds.length === 0) return false;
  if (hunks.every((h) => isTestPath(h.range.path))) return false;
  const byId = new Map(hunks.map((h) => [h.id, h]));
  return hunkIds.every((id) => {
    const hunk = byId.get(id);
    return hunk !== undefined && isTestPath(hunk.range.path);
  });
}

export function ownsTestHunk(hunks: readonly DiffHunk[], hunkIds: readonly string[]): boolean {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  return hunkIds.some((id) => {
    const hunk = byId.get(id);
    return hunk !== undefined && isTestPath(hunk.range.path);
  });
}

export function coverageRefusal(
  hunks: readonly DiffHunk[],
  owned: ReadonlyMap<string, readonly string[]>,
): string | null {
  const owners = new Map<string, string[]>();
  for (const [idea, ids] of owned) {
    for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), idea]);
  }
  const unknown = [...owners.keys()].filter((id) => !hunks.some((h) => h.id === id));
  if (unknown.length > 0) return `no such hunk: ${unknown.join(', ')} — the hunks are the ones listed in your prompt`;
  const unowned = hunks.filter((h) => !owners.has(h.id));
  if (unowned.length > 0) {
    const named = unowned.map((h) => `${h.id} (${h.range.path}:${h.range.start}-${h.range.end})`).join(', ');
    return `every hunk needs exactly one owning idea, and these have none: ${named}. Give each to the idea it belongs to, or to \`plumbing\` if there is nothing in it to review`;
  }
  const twice = [...owners.entries()].filter(([, ideas]) => ideas.length > 1);
  if (twice.length > 0) {
    const named = twice.map(([id, ideas]) => `${id} (owned by ${ideas.join(' and ')})`).join(', ');
    return `a hunk has exactly one owning idea, and these have more: ${named}. Keep the owner and cite the hunk from the other idea as a \`region\` anchor over the same lines`;
  }
  return null;
}
