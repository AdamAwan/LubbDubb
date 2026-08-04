import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The documentation asserts hundreds of facts about the code, and almost none of them can be
 * checked — so they rot silently and the failure mode is confident wrongness (#229). This closes
 * the one class that is both common and mechanically decidable: **a backticked repo-relative path
 * that no longer names anything**. A moved module leaves every document that pointed at it saying
 * something false, with nothing anywhere going red.
 *
 * Deliberately narrow. It checks that a named path *exists*, never that the prose about it is
 * true — an assertion that tried to would be a second, worse copy of the thing it guards. See
 * `docs/spec/19-development.md` for the position on what is left unchecked and why.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** Prefixes whose paths are real files in the tree. `docs/` at large is not one: prose legitimately
 *  names paths an *agent* might write (`docs/plan.md`), which are examples, not references. */
const CHECKED_PREFIXES = ['src/', 'web/', 'test/', 'scripts/', 'docs/spec/'];

/** Build outputs. Gitignored, absent on a fresh clone, and genuinely named by the specs. */
const BUILD_OUTPUTS = new Set(['web/dist']);

/** A backticked token that looks like a path: no globs, placeholders or ellipses. */
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

  // Not a style rule. This file is loaded into every agent's context on every dispatch, so its
  // length is a recurring fleet-wide cost (#229) — the reason the argument record lives in
  // `docs/spec/` and not here. The ceiling is generous; growth past it means a passage belongs in
  // a spec, not that the limit should move.
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
