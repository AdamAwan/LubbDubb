import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prCommentOrigin,
  prCommentsOrigin,
  reviewThreadNote,
  reviewThreadsNote,
} from '../src/dispatcher/reviewThreads.js';
import type { PrComment } from '../src/types.js';

const thread = (id: string, author: string, body: string): PrComment => ({ id, author, body, handled: false });

test('the dispatch origin is per PR and the signal ref is per thread', () => {
  // The whole point of the split: one agent answers a PR's review (one origin,
  // one attempt cap, one branch), while de-dup and a refused reply draft still
  // key on the individual thread.
  assert.equal(prCommentsOrigin(42), 'pr:42:comments');
  assert.equal(prCommentOrigin(42, 'c1'), 'pr:42:comment:c1');
  assert.notEqual(prCommentsOrigin(42), prCommentOrigin(42, 'c1'));
});

test('the thread ref is the same string a refused reply draft is filed under', () => {
  // `replyProposalRef(42, 'c1')` — asserted as a literal rather than by importing
  // it, so a change to either side fails here instead of silently agreeing.
  assert.equal(prCommentOrigin(42, 'c1'), 'pr:42:comment:c1');
});

test('every thread is rendered, numbered, with its id and author', () => {
  const note = reviewThreadsNote([
    thread('c1', 'you', 'rename this'),
    thread('c2', 'you', 'and pull it out of the loop'),
  ]);
  assert.match(note, /2 unresolved review threads/);
  assert.match(note, /1\. you \(thread c1\)/);
  assert.match(note, /2\. you \(thread c2\)/);
  assert.match(note, /rename this/);
  assert.match(note, /and pull it out of the loop/);
});

test('a single thread reads as one, not as "1 threads"', () => {
  const note = reviewThreadsNote([thread('c1', 'you', 'rename this')]);
  assert.match(note, /The unresolved review thread:/);
  assert.doesNotMatch(note, /1 unresolved review threads/);
});

test('a multi-line comment body cannot be read as the next thread', () => {
  // Bodies are free text from a reviewer and go straight into a prompt: an
  // unindented "2. do something else" inside one comment would read as a second
  // numbered thread the reviewer never wrote.
  const note = reviewThreadsNote([thread('c1', 'you', 'rename this\n2. and this')]);
  const lines = note.split('\n').filter((l) => l.includes('and this'));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^ {3}> /, 'every body line is quoted');
});

test('no threads renders nothing at all', () => {
  // Appended text lands after the cached prefix, so an empty render must be
  // byte-identical to a prompt composed before any of this existed.
  assert.equal(reviewThreadsNote([]), '');
});

test('a notify line names the PR, the author and the thread', () => {
  const note = reviewThreadNote(42, thread('c1', 'you', 'rename this'));
  assert.match(note, /PR #42/);
  assert.match(note, /you/);
  assert.match(note, /thread c1/);
  assert.match(note, /rename this/);
});
