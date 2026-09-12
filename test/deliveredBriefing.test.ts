import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { deliveredWorkBriefing } from '../src/briefing/delivered.js';
import { assessIssueNumber } from '../src/delivery/assessment.js';
import { planWithOnePart } from './support/plans.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import type { PlanPart, PullRequest } from '../src/types.js';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr40',
    number: 40,
    title: 'Add the endpoint',
    branch: 'issue/12',
    ciStatus: 'passing',
    unresolvedComments: [],
    state: 'merged',
    merged: true,
    closedAt: '2026-07-27T10:00:00.000Z',
    mergeCommitSha: 'abc1234',
    ...over,
  };
}

test('a goal with nothing recorded renders nothing at all', () => {
  assert.equal(deliveredWorkBriefing([]), '');
});

test('a merge is given the commit it left, and an abandoned pull request its branch', () => {
  const text = deliveredWorkBriefing([
    pr(),
    pr({ number: 44, title: 'The other half', branch: 'issue/12/api', state: 'closed', merged: false }),
  ]);
  assert.match(text, /#40 — merged .*as abc1234 \(branch issue\/12\)/);
  assert.match(text, /#44 — closed without merging.* — branch issue\/12\/api/);
  assert.doesNotMatch(text, /complete|delivered|satisfied/i);
  assert.doesNotMatch(text, /Add the endpoint/, 'the title is the graph’s to serve, not this block’s');
});

test('a pull request the harness never saw the end of says so, rather than reading as abandoned', () => {
  const text = deliveredWorkBriefing([pr({ state: undefined, merged: false })]);
  assert.match(text, /never recorded how it ended/);
  assert.doesNotMatch(text, /closed without merging/);
});

test('over the cap the oldest go, and the count that went is named', () => {
  const many = Array.from({ length: 30 }, (_, i) => pr({ number: i + 1, id: `pr${i}` }));
  const text = deliveredWorkBriefing(many);
  assert.match(text, /5 older pull requests of this goal were trimmed to fit/);
  assert.equal(text.split('\n').filter((l) => /^- #/.test(l)).length, 25);
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-delivered-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

async function dispatch(system: System, originRef: string): Promise<string> {
  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'dispatch_code_agent',
        title: 'Assess issue #12',
        prompt: 'THE TASK ITSELF',
        branch: 'assess/issue/12',
        base: 'main',
        readOnly: true,
        originRef,
        reason: 'r',
        rule: 'issue-assess',
      },
    ],
  } as unknown as DispatchResult;
  await system.executor.execute('cyc', plan);
  const task = system.store.tasks.listTasks().find((t) => t.originRef === originRef);
  assert.ok(task, 'nothing was dispatched, so there is no prompt to read');
  return system.store.tasks.getTask(task.id)?.prompt ?? '';
}

function partOnPr(system: System, prNumber: number): PlanPart {
  const plan = planWithOnePart(system.store, 12);
  const part = system.store.plans.listPlanParts(plan.id)[0]!;
  return system.store.plans.updatePlanPart(part.id, { status: 'merged', prNumber, branch: 'issue/12' })!;
}

test('an assessor is told where the goal’s merges are, and only this goal’s', async () => {
  const system = build();
  try {
    system.store.prArchive.archiveClosedPrs([
      pr(),
      pr({ id: 'pr41', number: 41, title: 'Somebody else', branch: 'issue/99', mergeCommitSha: 'dddd999' }),
    ]);
    partOnPr(system, 40);

    const prompt = await dispatch(system, 'issue:12:assess');

    assert.match(prompt, /^THE TASK ITSELF/);
    assert.match(prompt, /#40 — merged/, "the goal's own merged pull request");
    assert.match(prompt, /abc1234/, 'and the commit its merge left, which git cannot recover from the branch');
    assert.doesNotMatch(prompt, /dddd999/);
  } finally {
    system.store.close();
  }
});

test('a part’s pull request is the goal’s even where the branch convention does not say so', async () => {
  const system = build();
  try {
    system.store.prArchive.archiveClosedPrs([
      pr({ id: 'pr77', number: 77, branch: 'spike/whatever', mergeCommitSha: 'ee55f00' }),
    ]);
    partOnPr(system, 77);

    const prompt = await dispatch(system, 'issue:12:assess');
    assert.match(prompt, /#77 — merged .*as ee55f00/);
  } finally {
    system.store.close();
  }
});

test('an agent still building the goal is handed none of it', async () => {
  const system = build();
  try {
    system.store.prArchive.archiveClosedPrs([pr()]);
    const prompt = await dispatch(system, 'issue:12:part:whole');
    assert.doesNotMatch(prompt, /abc1234/);
    assert.doesNotMatch(prompt, /Where this goal’s pull requests are/);
  } finally {
    system.store.close();
  }
});

test('the assess origin is read in one place', () => {
  assert.equal(assessIssueNumber('issue:12:assess'), 12);
  assert.equal(assessIssueNumber('issue:12'), null);
  assert.equal(assessIssueNumber('issue:12:part:assess'), null);
  assert.equal(assessIssueNumber('pr:12:assess'), null);
});
