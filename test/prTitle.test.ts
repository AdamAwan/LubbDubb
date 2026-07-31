import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prTitleFields, renderPrTitle } from '../src/prTitle.js';
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
  assert.equal(render({ ...issue, position: 1, total: 1, type: 'docs', summary: 'sync runbook' }), '#182 docs: sync runbook');
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
