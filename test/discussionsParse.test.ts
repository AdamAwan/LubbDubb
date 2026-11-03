import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendBlock,
  cleanBody,
  formatEntry,
  parseDiscussion,
  restateEntry,
  setFrontMatterKeys,
  withMissingIds,
} from '../src/discussions/parse.js';
import {
  acceptedIdeas,
  answeredQuestions,
  notesNewestFirst,
  openQuestions,
  standingDecisions,
} from '../src/discussions/entries.js';

const FILE = `---
ref: issue:142
kind: story
title: Export to CSV
parent: '[[87 Reporting]]' # the feature
published: 2318842
pulled: 2026-11-03T14:02:11Z
tags:
  - reporting
aliases: [csv]
---

Some preamble the operator wrote.

## Decision · 2026-11-03 · operator ^d-7f3a

Export uses the browser's download, not a server-side file. Keeps it stateless.

## Question · open · 2026-11-03 · agent planner#912 ^q-21bc

Should empty columns be dropped or kept as blank?

## Idea · parked · 2026-11-02 · @sam (tracker) ^i-0c11

Offer XLSX as well.

\`\`\`md
## Not a heading · inside a fence
\`\`\`

## Question · answered · 2026-11-01 · operator ^q-0001

Which delimiter?

Answer: Commas.
Always commas.

## Decision · 2026-11-04 · operator ^d-0002

Export streams rows.

Supersedes ^d-7f3a

## Something I typed in a hurry

Still mine.

## Idea · 2026-11-04 · operator

No state and no id yet.
`;

test('the front matter is read, quoted and commented values included', () => {
  const { frontMatter } = parseDiscussion(FILE);
  assert.deepEqual(frontMatter, {
    ref: 'issue:142',
    kind: 'story',
    title: 'Export to CSV',
    parent: '[[87 Reporting]]',
    parentNumber: 87,
    published: '2318842',
    pulled: '2026-11-03T14:02:11Z',
  });
});

test('every heading is an entry, and a fenced heading is body', () => {
  const { entries } = parseDiscussion(FILE);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.state, e.id, e.unreadable]),
    [
      ['decision', null, 'd-7f3a', false],
      ['question', 'open', 'q-21bc', false],
      ['idea', 'parked', 'i-0c11', false],
      ['question', 'answered', 'q-0001', false],
      ['decision', null, 'd-0002', false],
      ['note', null, null, true],
      ['idea', 'open', null, false],
    ],
  );
  assert.match(entries[2]!.body, /## Not a heading/);
  assert.equal(entries[1]!.author, 'agent planner#912');
  assert.equal(entries[2]!.author, '@sam (tracker)');
});

test('an answer is the text below its Answer: line, and a decision names what it supersedes', () => {
  const { entries } = parseDiscussion(FILE);
  const answered = entries.find((e) => e.id === 'q-0001')!;
  assert.equal(answered.body, 'Which delimiter?');
  assert.equal(answered.answer, 'Commas.\nAlways commas.');
  assert.deepEqual(entries.find((e) => e.id === 'd-0002')!.supersedes, ['d-7f3a']);
});

test('a heading that does not parse is kept as an unreadable note, body and all', () => {
  const odd = parseDiscussion(
    '## Decision · open · 2026-11-03 · operator ^d-1\n\nx\n\n## Idea · someday · 2026-11-03 · me\n\ny\n\n## Note · 3 Nov · me\n\nz\n',
  ).entries;
  assert.deepEqual(
    odd.map((e) => [e.kind, e.unreadable, e.heading, e.body, e.id]),
    [
      ['note', true, 'Decision · open · 2026-11-03 · operator ^d-1', 'x', 'd-1'],
      ['note', true, 'Idea · someday · 2026-11-03 · me', 'y', null],
      ['note', true, 'Note · 3 Nov · me', 'z', null],
    ],
  );
});

test('the selectors hand over what an agent reads', () => {
  const { entries } = parseDiscussion(FILE);
  assert.deepEqual(
    standingDecisions(entries).map((e) => e.id),
    ['d-0002'],
  );
  assert.deepEqual(
    openQuestions(entries).map((e) => e.id),
    ['q-21bc'],
  );
  assert.deepEqual(
    answeredQuestions(entries).map((e) => e.id),
    ['q-0001'],
  );
  assert.deepEqual(acceptedIdeas(entries), []);
  assert.deepEqual(
    notesNewestFirst(entries).map((e) => e.heading),
    ['Something I typed in a hurry'],
  );
});

test('setting front-matter keys replaces only those lines and keeps the rest', () => {
  const next = setFrontMatterKeys(FILE, { published: '999', pulled: '2026-11-05T00:00:00Z', fresh: 'a: b' });
  assert.match(next, /^published: 999$/m);
  assert.match(next, /^pulled: 2026-11-05T00:00:00Z$/m);
  assert.match(next, /^fresh: 'a: b'$/m);
  assert.match(next, /^tags:\n {2}- reporting$/m);
  assert.match(next, /^aliases: \[csv\]$/m);
  assert.equal(next.split('\n').length, FILE.split('\n').length + 1);
  assert.equal(parseDiscussion(next).entries.length, 7);
});

test('a block value under a harness key is replaced with the key', () => {
  const next = setFrontMatterKeys('---\npulled:\n  - x\nkeep: 1\n---\nbody\n', { pulled: 't' });
  assert.equal(next, '---\npulled: t\nkeep: 1\n---\nbody\n');
});

test('a file without front matter gains some', () => {
  assert.equal(
    setFrontMatterKeys('## Note · 2026-11-03 · me\n', { ref: 'issue:1' }),
    '---\nref: issue:1\n---\n## Note · 2026-11-03 · me\n',
  );
});

test('a missing id is added to readable headings only', () => {
  let n = 0;
  const next = withMissingIds(FILE, (kind) => `${kind[0]}-new${++n}`);
  assert.match(next, /^## Idea · 2026-11-04 · operator \^i-new1$/m);
  assert.match(next, /^## Something I typed in a hurry$/m);
  assert.equal(
    withMissingIds(next, () => 'never'),
    next,
  );
});

test('a formatted entry parses back to itself', () => {
  const block = formatEntry({
    kind: 'question',
    state: 'open',
    date: '2026-11-03',
    author: 'operator',
    id: 'q-abcd',
    body: 'Dropped?\n## sneaky\n```\nunclosed',
  });
  const entries = parseDiscussion(appendBlock(FILE, block)).entries;
  assert.equal(entries.length, 8);
  const last = entries.at(-1)!;
  assert.deepEqual(
    [last.kind, last.state, last.id, last.author, last.date],
    ['question', 'open', 'q-abcd', 'operator', '2026-11-03'],
  );
  assert.match(last.body, /^\\## sneaky$/m);
});

test('appending separates the block by one blank line and keeps CRLF files CRLF', () => {
  assert.equal(appendBlock('a\n', 'b\n'), 'a\n\nb\n');
  assert.equal(appendBlock('a', 'b\n'), 'a\n\nb\n');
  assert.equal(appendBlock('a\r\n', 'b\nc\n'), 'a\r\n\r\nb\r\nc\r\n');
});

test('restating an entry changes its heading state and appends below its body', () => {
  const next = restateEntry(FILE, 'q-21bc', 'answered', 'Answer: Kept as blank.')!;
  const entry = parseDiscussion(next).entries.find((e) => e.id === 'q-21bc')!;
  assert.equal(entry.state, 'answered');
  assert.equal(entry.answer, 'Kept as blank.');
  assert.equal(entry.body, 'Should empty columns be dropped or kept as blank?');
  assert.equal(parseDiscussion(next).entries.length, 7);
  assert.equal(restateEntry(FILE, 'nope', 'answered', null), null);
});

test('a body heading is escaped and an unclosed fence closed', () => {
  assert.equal(cleanBody('## x\n### y'), '\\## x\n### y');
  assert.equal(cleanBody('```\n## in fence'), '```\n## in fence\n```');
});
