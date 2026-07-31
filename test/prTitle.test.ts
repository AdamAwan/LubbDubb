import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prTitleFields, renderPrTitle } from '../src/prTitle.js';
import { renamablePrs, type PrRenameContext } from '../src/prRename.js';
import type { Issue, PullRequest } from '../src/types.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';

const tpl = defaultPromptTemplates()
  .describe()
  .find((t) => t.id === 'pr-title')!.template;

function render(input: Parameters<typeof prTitleFields>[0]): string {
  return renderPrTitle(tpl, prTitleFields(input));
}

const issue = { number: 182, title: 'Ticket sync rewrite' };

test('a stacked PR renders its position, type and scope', () => {
  assert.equal(
    render({ ...issue, position: 2, total: 4, type: 'feat', scope: 'store', summary: 'sync cursor table' }),
    '#182 [2/4] feat(store): sync cursor table',
  );
});

test('a PR that stacks on nothing has no position clause at all', () => {
  assert.equal(
    render({ ...issue, position: 1, total: 1, type: 'feat', scope: 'store', summary: 'sync cursor table' }),
    '#182 feat(store): sync cursor table',
  );
});

test('an undeclared scope leaves no empty parentheses', () => {
  assert.equal(
    render({ ...issue, position: 1, total: 1, type: 'docs', summary: 'sync runbook' }),
    '#182 docs: sync runbook',
  );
});

test('an undeclared type leaves no stray colon', () => {
  assert.equal(render({ ...issue, position: 1, total: 1, summary: 'sync cursor table' }), '#182 sync cursor table');
});

test('a summary is trimmed rather than rendered with its whitespace', () => {
  assert.equal(render({ ...issue, position: 1, total: 1, summary: '  sync cursor table\n' }), '#182 sync cursor table');
});

test('an override that omits the position still renders — the clauses are optional, not required', () => {
  const fields = prTitleFields({ ...issue, position: 2, total: 4, type: 'feat', summary: 'cursor' });
  assert.equal(renderPrTitle('{kind}{summary} (#{number})', fields), 'feat: cursor (#182)');
});

test('an unknown placeholder is left standing rather than silently blanked', () => {
  const fields = prTitleFields({ ...issue, position: 1, total: 1, summary: 'cursor' });
  assert.equal(renderPrTitle('{nope} {summary}', fields), '{nope} cursor');
});

// ---------------------------------------------------------------------------
// Rename, and the two arms of the prAuthor gate
// ---------------------------------------------------------------------------

function pr(over: Partial<PullRequest> & { number: number; branch: string }): PullRequest {
  return {
    id: `pr_${over.number}`,
    title: `PR ${over.number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    baseBranch: 'main',
    ...over,
  };
}

const issues: Issue[] = [
  {
    id: 'i164',
    number: 164,
    title: 'Flaky worktree reclaim',
    body: '',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
  },
  { id: 'i182', number: 182, title: 'Ticket sync rewrite', body: '', state: 'open', labels: [], linkedPrNumber: null },
];

function renameCtx(over: Partial<PrRenameContext> = {}): PrRenameContext {
  return { prAuthorConfigured: true, template: tpl, issues, ...over };
}

test('with prAuthor set, every PR in the world is renamable — the provider already filtered it', () => {
  const out = renamablePrs(
    [pr({ number: 39, title: 'reclaim stale worktree dirs', branch: 'issue/164/reclaim' })],
    renameCtx(),
  );
  assert.deepEqual(out, [{ prNumber: 39, title: '#164 reclaim stale worktree dirs' }]);
});

test('with prAuthor unset, only PRs on branches the harness mints are renamable', () => {
  const ctx = renameCtx({ prAuthorConfigured: false });
  const out = renamablePrs(
    [
      pr({ number: 39, branch: 'issue/164/reclaim' }),
      pr({ number: 40, branch: 'fix/their-thing', title: 'their work' }),
    ],
    ctx,
  );
  assert.deepEqual(
    out.map((o) => o.prNumber),
    [39],
    "a colleague's pull request, on their own branch, is never renamed",
  );
});

test('with prAuthor unset, a linked PR on a foreign branch is still left alone', () => {
  // It resolves to an issue, so the *naming* half would happily rename it; the gate
  // is what stops it, and this is the case that proves the gate is doing the work.
  const linked: Issue[] = [{ ...issues[1]!, linkedPrNumber: 77 }];
  const out = renamablePrs(
    [pr({ number: 77, title: 'theirs', branch: 'their/branch' })],
    renameCtx({ prAuthorConfigured: false, issues: linked }),
  );
  assert.deepEqual(out, []);
});

test('a PR already on the convention is not rewritten', () => {
  const out = renamablePrs(
    [pr({ number: 44, title: '#182 sync cursor table', branch: 'issue/182/cursor' })],
    renameCtx(),
  );
  assert.deepEqual(out, [], 'idempotent, so a settled PR costs nothing every pulse');
});

test('renaming twice does not stack prefixes', () => {
  const first = renamablePrs([pr({ number: 44, title: 'sync cursor table', branch: 'issue/182/cursor' })], renameCtx());
  assert.equal(first[0]?.title, '#182 sync cursor table');
  const second = renamablePrs([pr({ number: 44, title: first[0]!.title, branch: 'issue/182/cursor' })], renameCtx());
  assert.deepEqual(second, []);
});

test('a stack rung is renamed with its position', () => {
  const out = renamablePrs(
    [pr({ number: 45, title: 'cursor table', branch: 'issue/182/cursor' })],
    renameCtx({
      positions: new Map([[45, { position: 2, total: 4 }]]),
    }),
  );
  assert.deepEqual(out, [{ prNumber: 45, title: '#182 [2/4] cursor table' }]);
});

test('a PR belonging to no issue is left alone — the convention is keyed on an issue number', () => {
  const out = renamablePrs([pr({ number: 9, title: 'drive-by fix', branch: 'feat/whatever' })], renameCtx());
  assert.deepEqual(out, []);
});

test('a merged PR is never renamed', () => {
  const out = renamablePrs([pr({ number: 44, title: 'x', branch: 'issue/182/cursor', merged: true })], renameCtx());
  assert.deepEqual(out, []);
});

test('a linked PR is renamed off its link rather than its branch', () => {
  const linked: Issue[] = [{ ...issues[1]!, linkedPrNumber: 77 }];
  const out = renamablePrs(
    [pr({ number: 77, title: 'whatever', branch: 'some/other/branch' })],
    renameCtx({ issues: linked }),
  );
  assert.deepEqual(out, [{ prNumber: 77, title: '#182 whatever' }]);
});
