import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAINNESS, plainnessRefusal, readingEase, readingEaseRefusal } from '../src/reviewPacks/plainness.js';

test('a semicolon is refused, because it is a full stop that will not admit it', () => {
  const refusal = plainnessRefusal(
    'gist',
    'Fold and predicate become shared consts; the new query adds an ordering test.',
  );
  assert.match(refusal ?? '', /semicolon/);
  assert.match(refusal ?? '', /Fold and predicate/, 'the refusal quotes what it caught');
});

test('a clause hung off a dash is refused, and a hyphen inside a word is not', () => {
  assert.match(
    plainnessRefusal('gist', 'Legacy clears the workflow when no match row exists — the first-bind case.') ?? '',
    /clause off a dash/,
  );
  assert.equal(plainnessRefusal('gist', 'The first-bind case clears the workflow.'), null);
  assert.equal(plainnessRefusal('gist', 'A well-known ledger-status-clear path keeps the old guard.'), null);
});

test('a sentence over the word limit is refused, and the limit is what the message says', () => {
  const long = `The consumer ${'reads the guard and '.repeat(6)}returns.`;
  const refusal = plainnessRefusal('ideas[0].claim', long);
  assert.match(refusal ?? '', new RegExp(`the limit is ${PLAINNESS.sentenceWords}`));
  assert.equal(plainnessRefusal('ideas[0].claim', 'The consumer reads the new, narrower guard.'), null);
});

test('two short sentences pass where one long one would not', () => {
  const two = 'The consumer reads the new guard. Handover and ledger-status-clear keep the old one.';
  assert.equal(plainnessRefusal('gist', two), null);
});

test('code is never counted — an identifier is not a long word and a grep is not a sentence', () => {
  assert.equal(
    plainnessRefusal('gist', 'The consumer now calls `GetTargetsWithWorkflowSetBeforeTheirBinding` instead.'),
    null,
  );
  assert.equal(plainnessRefusal('evidence', 'Read `MatchEventDAL.cs:218-234` at the head.'), null);
  const table = 'The claim is wrong.\n\n| Reader | Row type |\n|---|---|\n| a very long identifier here | yes |';
  assert.equal(plainnessRefusal('finding.body', table), null, 'a table row is not prose');
});

test('reading ease scores plain prose above the floor and dense prose below it', () => {
  const plain = ['The guard only fires for an old workflow.', 'One consumer moved. Two kept the old guard.'];
  assert.ok(readingEase(plain).ease > PLAINNESS.readingEase, `plain prose scored ${readingEase(plain).ease}`);
  assert.equal(readingEaseRefusal(plain), null);

  const dense = [
    'Attribution of the consequential reconciliation determines authoritative provenance.',
    'Subsequent verification demonstrates unequivocally incompatible instantiation.',
  ];
  const refusal = readingEaseRefusal(dense);
  assert.match(refusal ?? '', /reading ease/);
  assert.match(refusal ?? '', /Attribution|Subsequent/, 'the hardest sentences are named');
});

test('the hardest sentences are the ones named, worst first', () => {
  const { hardest } = readingEase([
    'The guard moved.',
    'Incontrovertible documentation substantiates the aforementioned interpretation.',
    'One consumer changed.',
  ]);
  assert.match(hardest[0] ?? '', /Incontrovertible/);
});

test('an empty set of fields is not a failure', () => {
  assert.equal(readingEaseRefusal([]), null);
  assert.equal(readingEase([]).ease, 100);
});
