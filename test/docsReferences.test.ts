import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT as ROOT } from './support/paths.js';

const CHECKED_PREFIXES = ['src/', 'web/', 'test/', 'scripts/', 'docs/spec/'];

const BUILD_OUTPUTS = new Set(['web/dist']);

const PATH_TOKEN = /`([A-Za-z0-9._/-]+\/[A-Za-z0-9._/-]*)`/g;

const DIRECTORY_NOTES = ['src', 'test', 'web']
  .flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).map((p) => `${dir}/${p}`))
  .filter((p) => p.endsWith('/CLAUDE.md'));

function markdownFiles(): string[] {
  const files = ['CLAUDE.md', ...DIRECTORY_NOTES, 'README.md', 'docs/README.md', 'docs/workflow.md'];
  for (const dir of ['docs/spec', 'docs/prompt-templates']) {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (entry.endsWith('.md')) files.push(`${dir}/${entry}`);
    }
  }
  return files.filter((f) => existsSync(join(ROOT, f)));
}

test('every repo path the docs name in backticks exists', () => {
  const broken: string[] = [];

  for (const file of markdownFiles()) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const seen = new Set<string>();
    for (const match of text.matchAll(PATH_TOKEN)) {
      const path = match[1]!.replace(/\/$/, '');
      if (seen.has(path)) continue;
      seen.add(path);
      if (BUILD_OUTPUTS.has(path)) continue;
      if (!CHECKED_PREFIXES.some((p) => path.startsWith(p))) continue;
      if (!existsSync(join(ROOT, path))) broken.push(`${file}: ${path}`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    `Documentation names paths that do not exist. Fix the reference, or the move that orphaned it:\n  ${broken.join('\n  ')}`,
  );
});

test('CLAUDE.md stays small enough to load into every agent', () => {
  const lines = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split('\n').length;

  assert.ok(lines < 400, `CLAUDE.md is ${lines} lines; the always-loaded file is capped at 400.`);
});

test('every relative link in a CLAUDE.md resolves, and the root lists every directory note', () => {
  const broken: string[] = [];
  for (const file of ['CLAUDE.md', ...DIRECTORY_NOTES]) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = match[1]!;
      if (/^[a-z]+:/.test(target)) continue;
      if (!existsSync(join(ROOT, dirname(file), target))) broken.push(`${file}: ${target}`);
    }
  }
  const root = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const unlisted = DIRECTORY_NOTES.filter((note) => !root.includes(`](${note})`));

  assert.deepEqual(broken, [], `A CLAUDE.md links to something that does not exist:\n  ${broken.join('\n  ')}`);
  assert.deepEqual(unlisted, [], `The root CLAUDE.md's Directory notes omit:\n  ${unlisted.join('\n  ')}`);
});

test('every spec document the index lists exists, and every spec is listed', () => {
  const index = readFileSync(join(ROOT, 'docs/README.md'), 'utf8');
  const listed = new Set([...index.matchAll(/\(spec\/([0-9a-z-]+\.md)\)/g)].map((m) => m[1]!));
  const present = readdirSync(join(ROOT, 'docs/spec')).filter((f) => f.endsWith('.md'));

  assert.deepEqual(
    present.filter((f) => !listed.has(f)),
    [],
    'A spec document exists that docs/README.md does not index.',
  );
  assert.deepEqual(
    [...listed].filter((f) => !present.includes(f)),
    [],
    'docs/README.md indexes a spec document that does not exist.',
  );
});

function headingSlugs(text: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]!
      .toLowerCase()
      .split(/(`[^`]*`)/)
      .map((part, i) => (i % 2 ? part : part.replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')))
      .join('')
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let seen = counts.get(base) ?? 0;
    let slug = seen === 0 ? base : `${base}-${seen}`;
    while (slugs.has(slug)) slug = `${base}-${++seen}`;
    counts.set(base, seen + 1);
    slugs.add(slug);
  }
  return slugs;
}

const INVARIANT = /^- \*\*.+\*\*.* → \[§\]\(#([^)]+)\) · (?:`(test\/[A-Za-z0-9._/-]+\.test\.ts)`|_no test_)$/;

test('every spec opens with an Invariants list, each line linking its section and its test or _no test_', () => {
  const problems: string[] = [];
  for (const file of readdirSync(join(ROOT, 'docs/spec')).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(join(ROOT, 'docs/spec', file), 'utf8');
    const lines = text.split(/\r?\n/);
    const first = lines.findIndex((l) => l.startsWith('## '));
    if (lines[first] !== '## Invariants') {
      problems.push(`${file}: the first section is not "## Invariants"`);
      continue;
    }
    const next = lines.findIndex((l, i) => i > first && l.startsWith('## '));
    const bullets = lines.slice(first + 1, next === -1 ? lines.length : next).filter((l) => l.startsWith('- '));
    if (bullets.length === 0) problems.push(`${file}: the Invariants list is empty`);
    const slugs = headingSlugs(text);
    for (const bullet of bullets) {
      const match = INVARIANT.exec(bullet);
      if (!match) problems.push(`${file}: malformed invariant: ${bullet.slice(0, 80)}`);
      else if (!slugs.has(match[1]!)) problems.push(`${file}: invariant links #${match[1]}, which is no heading here`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `Each spec's Invariants lines are "- **rule** why. → [§](#section) · \`test/x.test.ts\`" or "· _no test_" (docs/spec/19-development.md#what-holds-the-documentation-honest):\n  ${problems.join('\n  ')}`,
  );
});
