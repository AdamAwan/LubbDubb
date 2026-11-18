import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { DISCUSSION_AUTHORS } from '../src/discussions/discussionFile.js';
import { askQueue } from '../src/server/askReads.js';
import { answerWith } from '../src/mcp/askAnswers.js';
import { failAppraisalOpen } from './support/plans.js';

// → docs/spec/40-discussions.md#where-else-it-is-reached-from

function system(discussions: boolean): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discussion-ask-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      repoRoot: dir,
      ...(discussions ? { discussionsDir: join(dir, 'vault') } : {}),
      heartbeatIntervalMs: 999_999,
    }),
    {
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      worktrees: new FakeWorktreeManager(),
      errorMirror: () => {},
    },
  );
}

const ask = (s: System) => askQueue(s).find((row) => row.kind === 'questions');

test('a story held on open questions is one ask in "Needs you" until the last is answered', async () => {
  const s = system(true);
  s.connector.inject({ kind: 'new_issue', number: 1, title: 'Export to CSV', body: 'Please.' });
  failAppraisalOpen(s.store, 1);
  const first = s.discussions.add(
    { number: 1, title: 'Export to CSV', kind: 'story' },
    { kind: 'question', body: 'Drop empty columns?', author: DISCUSSION_AUTHORS.agent('issue-plan', 't1') },
  );
  const second = s.discussions.add(
    { number: 1, title: 'Export to CSV', kind: 'story' },
    { kind: 'question', body: 'Which delimiter?', author: DISCUSSION_AUTHORS.operatorViaClaude },
  );
  assert.ok(first.ok && second.ok);
  assert.equal(ask(s), undefined, 'nothing is held before the dispatcher has held it');

  await s.harness.runCycle('manual');
  const row = ask(s);
  assert.ok(row, 'the held story is a row');
  assert.equal(row.id, 'questions:issue:1');
  assert.deepEqual(row.subject, { type: 'issue', issueNumber: 1 });
  assert.equal(row.goalRef, 'issue:1');
  assert.match(row.title, /Waiting on open questions for #1 · Export to CSV/);
  assert.match(row.note ?? '', /waiting on 2 open questions/);
  assert.equal(askQueue(s).filter((r) => r.kind === 'questions').length, 1, 'one row per story');

  const answer = answerWith(row, { link: null, profileNames: [], proposalKind: () => null });
  assert.equal(answer.in, 'claude-code');
  if (answer.in === 'claude-code') {
    assert.equal(answer.tool, 'discussion_settle');
    assert.deepEqual(answer.args, { issue: 1, action: 'answer' });
    assert.deepEqual(answer.readFirst, [{ tool: 'discussion_read', args: { issue: 1 } }]);
    assert.match(answer.note ?? '', /\/lubbdubb:discuss 1/);
  }

  assert.ok(s.discussions.settle(1, first.entry.id!, { action: 'answer', answer: 'Keep them blank.' }).ok);
  await s.harness.runCycle('manual');
  assert.match(ask(s)?.note ?? '', /waiting on 1 open question\b/, 'it stands while one is open');

  assert.ok(s.discussions.settle(1, second.entry.id!, { action: 'answer', answer: 'Comma.' }).ok);
  await s.harness.runCycle('manual');
  assert.equal(ask(s), undefined, 'the hold lifted, the ask is gone');
  s.store.close();
});

test('with discussions off no story is a questions ask', async () => {
  const s = system(false);
  s.connector.inject({ kind: 'new_issue', number: 1, title: 'Export to CSV', body: 'Please.' });
  failAppraisalOpen(s.store, 1);
  await s.harness.runCycle('manual');
  assert.equal(ask(s), undefined);
  s.store.close();
});
