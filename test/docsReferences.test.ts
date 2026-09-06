import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const CHECKED_PREFIXES = ['src/', 'web/', 'test/', 'scripts/', 'docs/spec/'];

const BUILD_OUTPUTS = new Set(['web/dist']);

const PATH_TOKEN = /`([A-Za-z0-9._/-]+\/[A-Za-z0-9._/-]*)`/g;

function markdownFiles(): string[] {
  const files = ['CLAUDE.md', 'README.md', 'docs/README.md', 'docs/workflow.md'];
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
