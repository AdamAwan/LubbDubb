// → docs/spec/07-pull-requests.md#what-the-harness-can-see-for-itself

/** A family of change that cannot be taken back by reverting the pull request. */
interface OneWayTouch {
  label: string;
  where: string[];
}

/**
 * What the clone can say about a pull request's diff without asking the agent that
 * wrote it.
 *
 * Every field here is read off the diff, so none of it is an account of the change
 * by the thing that made it. `null` from `diffFacts` is *could not look* and never
 * *nothing found* — the triggers that rest on this fail open.
 */
export interface DiffFacts {
  files: string[];
  oneWay: OneWayTouch[];
  testsChanged: boolean;
  codeChanged: boolean;
}

/**
 * The surfaces a change cannot be taken back from, as a path family or a marker in
 * the added lines.
 *
 * Deliberately a list of the repo's own one-way doors rather than a general idea of
 * risk: a schema that has run, a row that has gone, a name the world has seen. Each
 * row is a *trigger* and never a verdict — it decides that the question is owed, and
 * the answer is the agent's.
 */
const ONE_WAY: readonly { label: string; path?: RegExp; added?: RegExp }[] = [
  { label: 'the database schema and its migrations', path: /^src\/store\// },
  {
    label: 'a schema statement that runs once against every existing database',
    added: /\bALTER\s+TABLE\b|\bDROP\s+(?:TABLE|INDEX|COLUMN)\b|\bCREATE\s+UNIQUE\s+INDEX\b/i,
  },
  { label: 'rows this deletes rather than supersedes', added: /\bDELETE\s+FROM\b/i },
  { label: 'a one-shot migration id, which every database runs again if it changes', added: /\brunOnce\s*\(/ },
  { label: 'a write into the world under the operator’s account', path: /^src\/(?:sink|tickets)\// },
  {
    label: 'a name an operator’s deployment may already override',
    path: /^src\/mcp\/names\.ts$|^src\/dispatcher\/promptTemplates\.ts$/,
  },
  { label: 'the upgrade handoff, which decides which build comes back', path: /^src\/selfUpdate\// },
  { label: 'a working tree this wipes or rewinds', added: /git\s+clean|-ffdx|switch\s+-C\b|checkout\s+-B\b/ },
];

/** Every path the diff touches, as the diff names them after a rename. */
export function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      files.add(git[2]!);
      continue;
    }
    const to = /^\+\+\+ b\/(.+)$/.exec(line);
    if (to) files.add(to[1]!);
  }
  files.delete('/dev/null');
  return [...files].sort();
}

/** What the clone can say about this diff, or null when it could not read one. */
export function diffFacts(diff: string | null): DiffFacts | null {
  if (diff === null) return null;
  const files = changedFiles(diff);
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');

  const oneWay: OneWayTouch[] = [];
  for (const surface of ONE_WAY) {
    const where = surface.path ? files.filter((f) => surface.path!.test(f)) : [];
    const marked = surface.added !== undefined && surface.added.test(added);
    if (where.length > 0 || marked) oneWay.push({ label: surface.label, where });
  }

  return {
    files,
    oneWay,
    testsChanged: files.some((f) => /^test\/.+\.test\.tsx?$/.test(f)),
    codeChanged: files.some((f) => /^(?:src|web\/src)\/.+\.tsx?$/.test(f)),
  };
}

const FILES_SHOWN = 12;

/** The computed block: what the diff touches, said by the clone rather than the author. */
export function renderDiffFacts(facts: DiffFacts): string[] {
  const shown = facts.files.slice(0, FILES_SHOWN).map((f) => `\`${f}\``);
  const rest = facts.files.length - shown.length;
  const lines = [
    `- ${facts.files.length} file${facts.files.length === 1 ? '' : 's'}: ` +
      shown.join(', ') +
      (rest > 0 ? `, and ${rest} more` : ''),
    `- Tests changed: ${facts.testsChanged ? 'yes' : 'no'}`,
  ];
  for (const touch of facts.oneWay) {
    const where = touch.where.length > 0 ? `: ${touch.where.map((f) => `\`${f}\``).join(', ')}` : '';
    lines.push(`- Touches ${touch.label}${where}`);
  }
  return lines;
}
