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

test('the re-check names the read that answers it, on this PR', () => {
  // The whole instruction is "go and look again", so it has to say *how*: an
  // agent told to check without being told the call shells out to `gh`, or
  // guesses, or skips it.
  const note = reviewRecheckNote(42);
  assert.match(note, /world_read\("pr", "pr:42"\)/);
  assert.match(note, /unresolvedComments/);
  assert.match(note, /observedAt/);
});

test('the re-check covers a thread that appeared and a thread that was edited', () => {
  // Two different misses, and only the first has any other path to the agent —
  // notify delivers a *new* thread to a running agent, and an edit to a thread
  // already in the prompt is no signal at all.
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
  // The bug this exists for: the operator replies under a bot's finding saying
  // which part actually needs fixing and how, and the agent was handed the bot's
  // opening line and nothing else — answering the wrong question while the person
  // who wrote the reply watched it ignore them.
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
  // Unmarked, an agent reads the harness's last answer back as a fresh
  // instruction and makes the same change twice.
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
  // A root-only review renders byte-identically to before this existed: the
  // ordering rule is about a conversation, and there isn't one.
  assert.doesNotMatch(reviewThreadsNote([thread('c1', 'reviewer', 'a finding')]), /live ask/i);
});

test('the re-check covers a thread that gained a reply', () => {
  // The commonest way a review moves mid-run, and the one an edit-or-new-thread
  // check reads as nothing having happened.
  assert.match(reviewRecheckNote(7), /carrying a reply that is not above/);
});

test('a notify line carries the replies that moved the thread', () => {
  // This line is often the only delivery a follow-up gets — it is sent *because*
  // the thread moved, and what moved it is the reply.
  const note = reviewThreadNote(42, {
    ...thread('c1', 'reviewer', 'this loop looks expensive'),
    replies: [reply('r1', 'operator', 'only the inner one')],
  });
  assert.match(note, /only the inner one/);
  assert.match(note, /live ask/);
});

test('the notify de-dup key moves when a thread gains a reply, and the thread ref does not', () => {
  // Keyed on the thread alone, a follow-up on a thread the running agent was
  // already told about reads as something already delivered and reaches nobody.
  // The ref must not move with it: it is what a refused reply draft is filed
  // under and what `rejectionGuidance` matches whole.
  const root = thread('c1', 'reviewer', 'a finding');
  const answered = { ...root, replies: [reply('r1', 'operator', 'narrow it to the parser')] };
  assert.equal(prCommentSignalRef(42, root), prCommentOrigin(42, 'c1'));
  assert.notEqual(prCommentSignalRef(42, answered), prCommentSignalRef(42, root));
  assert.equal(prCommentOrigin(42, 'c1'), 'pr:42:comment:c1');
});
