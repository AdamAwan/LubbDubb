import type { ReviewRange } from '../types.js';

/**
 * The diff as the pack sees it: a list of hunks, each with the range it occupies
 * **at the head sha** and its lines with their diff prefixes.
 * → `docs/spec/31-review-packs.md#coverage`
 *
 * Pure, and the one place a hunk's range is computed. The reviewer's marks are
 * keyed on exactly this range (`ReviewMark`), and the coverage check compares
 * ideas against exactly this list — so the author is handed these hunks by id and
 * names them back, never a range of its own. A range the agent transcribed would
 * be one a mark never matches again, with nothing red.
 */
export interface DiffHunk {
  /** `h1`, `h2`, … in diff order — what the prompt lists and the tool takes back. */
  id: string;
  /** Where the hunk's lines are at the head sha — the `+` side of the hunk header. */
  range: ReviewRange;
  /** The hunk body as `git diff` printed it: context, `+` and `-` lines, prefixes kept. */
  code: string[];
  /** Lines added and removed, for the prompt's one-line summary of each hunk. */
  added: number;
  removed: number;
}

/**
 * Parse `git diff <base>...<head>` into hunks.
 *
 * A hunk is what git calls a hunk, at git's default context: what a reviewer
 * points at when they say "this hunk", and the unit the ideas are checked
 * against. The range is read off the `+c,d` half of the header, so it names the
 * lines as they stand at the head — `c` to `c + d - 1`, 1-based and inclusive.
 *
 * **A pure-deletion hunk carries a zero-width range** at the line the deletion
 * sits after: `d` is 0 and git's `c` is the line *before* the gap, so the range is
 * `{c, c}`, clamped to line 1 for a deletion at the top of a file. Its code is
 * the removed lines, prefixed `-`. A deleted file keeps its old path, because
 * there is no new one to name; nothing at the head has those lines, and a mark on
 * that range is keyed to a place rather than to code, honestly.
 *
 * A binary file and a pure rename produce no hunk: there is nothing for an idea
 * to own, and nothing for a reviewer to read.
 */
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
    // Inside a hunk, a line is body first: a removed line reading `-- x` prints as
    // `--- x`, and read as a file header it would drop the hunk's path.
    if (current !== null && /^[-+ \\]/.test(line)) {
      if (line.startsWith('+')) current.added += 1;
      else if (line.startsWith('-')) current.removed += 1;
      current.code.push(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      // The old path, kept only for a deleted file, whose `+++` names nothing.
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
    // Anything else is the next file's header material, not hunk body.
    current = null;
  }
  return hunks;
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → null. Git quotes unusual paths, and those stay quoted. */
function stripPathPrefix(raw: string): string | null {
  const name = raw.replace(/\t.*$/, '');
  if (name === '/dev/null') return null;
  return name.replace(/^[ab]\//, '');
}

/**
 * The coverage rule, decided mechanically: every hunk has exactly one owning
 * idea. `owned` is, per idea, the hunk ids its `hunk` anchors name — `plumbing`
 * included, since it is declared like any other idea.
 *
 * Returns the sentence that refuses the pack, or null when every hunk is owned
 * once. The sentence names the hunks, because the agent has to find them.
 */
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
