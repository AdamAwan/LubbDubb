import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prCommentOrigin,
  prCommentSignalRef,
  prCommentsOrigin,
  reviewRecheckNote,
  reviewThreadNote,
  reviewThreadsNote,
} from '../src/dispatcher/reviewThreads.js';
import type { PrComment } from '../src/types.js';

const thread = (id: string, author: string, body: string): PrComment => ({ id, author, body, handled: false });

test('the dispatch origin is per PR and the signal ref is per thread', () => {
  assert.equal(prCommentsOrigin(42), 'pr:42:comments');
  assert.equal(prCommentOrigin(42, 'c1'), 'pr:42:comment:c1');
  assert.notEqual(prCommentsOrigin(42), prCommentOrigin(42, 'c1'));
});

test('the thread ref is the same string a refused reply draft is filed under', () => {
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
  const note = reviewThreadsNote([thread('c1', 'you', 'rename this\n2. and this')]);
  const lines = note.split('\n').filter((l) => l.includes('and this'));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^ {3}> /, 'every body line is quoted');
});

test('no threads renders nothing at all', () => {
  assert.equal(reviewThreadsNote([]), '');
});

test('the re-check names the read that answers it, on this PR', () => {
  const note = reviewRecheckNote(42);
  assert.match(note, /world_read\("pr", "pr:42"\)/);
  assert.match(note, /unresolvedComments/);
  assert.match(note, /observedAt/);
});

test('the re-check covers a thread that appeared and a thread that was edited', () => {
  const note = reviewRecheckNote(7);
  assert.match(note, /not above/);
  assert.match(note, /edited after you started/);
});

test('a notify line names the PR, the author and the thread', () => {
  const note = reviewThreadNote(42, thread('c1', 'you', 'rename this'));
  assert.match(note, /PR #42/);
  assert.match(note, /you/);
  assert.match(note, /thread c1/);
  assert.match(note, /rename this/);
});

const reply = (id: string, author: string, body: string, ours = false) => ({ id, author, body, ours });

test('a thread renders its replies, not just the root', () => {
  const note = reviewThreadsNote([
    {
      ...thread('c1', 'reviewer', 'this loop looks expensive'),
      replies: [reply('r1', 'operator', 'only the inner one — hoist the lookup out of it')],
    },
  ]);
  assert.match(note, /this loop looks expensive/);
  assert.match(note, /operator replied:/);
  assert.match(note, /hoist the lookup out of it/);
});

test('a reply body is quoted like a root, so it cannot be read as another thread', () => {
  const note = reviewThreadsNote([
    { ...thread('c1', 'reviewer', 'a finding'), replies: [reply('r1', 'operator', 'fix it\n2. and this')] },
  ]);
  const lines = note.split('\n').filter((l) => l.includes('and this'));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^ {3}> /);
});

test("the fleet's own replies are marked as its own", () => {
  const note = reviewThreadsNote([
    { ...thread('c1', 'reviewer', 'a finding'), replies: [reply('r1', 'operator', 'done in a5f2', true)] },
  ]);
  assert.match(note, /\(the fleet, earlier\)/);
});

test('the newest message is named as the live ask, and only when there is a conversation', () => {
  const withReplies = reviewThreadsNote([
    { ...thread('c1', 'reviewer', 'a finding'), replies: [reply('r1', 'operator', 'narrow it to the parser')] },
  ]);
  assert.match(withReplies, /last message in a thread is the live ask/i);
  assert.doesNotMatch(reviewThreadsNote([thread('c1', 'reviewer', 'a finding')]), /live ask/i);
});

test('the re-check covers a thread that gained a reply', () => {
  assert.match(reviewRecheckNote(7), /carrying a reply that is not above/);
});

test('a notify line carries the replies that moved the thread', () => {
  const note = reviewThreadNote(42, {
    ...thread('c1', 'reviewer', 'this loop looks expensive'),
    replies: [reply('r1', 'operator', 'only the inner one')],
  });
  assert.match(note, /only the inner one/);
  assert.match(note, /live ask/);
});

test('the notify de-dup key moves when a thread gains a reply, and the thread ref does not', () => {
  const root = thread('c1', 'reviewer', 'a finding');
  const answered = { ...root, replies: [reply('r1', 'operator', 'narrow it to the parser')] };
  assert.equal(prCommentSignalRef(42, root), prCommentOrigin(42, 'c1'));
  assert.notEqual(prCommentSignalRef(42, answered), prCommentSignalRef(42, root));
  assert.equal(prCommentOrigin(42, 'c1'), 'pr:42:comment:c1');
});
