import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { deliveredWorkBriefing } from '../src/briefing/delivered.js';
import { assessIssueNumber } from '../src/delivery/assessment.js';
import { planWithOnePart } from './support/plans.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import type { PlanPart, PullRequest } from '../src/types.js';

/**
 * Where a goal's pull requests are in the checkout the assessor stands in.
 *
 * Deliberately not an account of what the goal delivered — `world_read` already
 * serves the work subtree and the plan graph, and a second one here would be the
 * staler copy. What it carries is the two fields that subtree does not: the merge
 * commit, which a squash merge leaves no ancestry link to, and the branch.
 * → `docs/spec/09-execution.md#where-a-goals-merges-are-reaches-the-assessor`
 */

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

// -- the pure briefing -------------------------------------------------------

test('a goal with nothing recorded renders nothing at all', () => {
  // Empty means empty: no heading over an empty list, so a prompt with nothing
  // behind it is byte-identical to one composed before this existed.
  assert.equal(deliveredWorkBriefing([]), '');
});

test('a merge is given the commit it left, and an abandoned pull request its branch', () => {
  const text = deliveredWorkBriefing([
    pr(),
    pr({ number: 44, title: 'The other half', branch: 'issue/12/api', state: 'closed', merged: false }),
  ]);
  assert.match(text, /#40 — merged .*as abc1234 \(branch issue\/12\)/);
  assert.match(text, /#44 — closed without merging.* — branch issue\/12\/api/);
  // It says where to look, never what happened: no verdict, no ranking, and no
  // second account of what each pull request was for — `world_read` carries the
  // work subtree, and the assessor's whole job is to judge it.
  assert.doesNotMatch(text, /complete|delivered|satisfied/i);
  assert.doesNotMatch(text, /Add the endpoint/, 'the title is the graph’s to serve, not this block’s');
});

test('a pull request the harness never saw the end of says so, rather than reading as abandoned', () => {
  // `GitObserver.contains`' rule, and the reason the outcome is three-valued: an
  // assessor told "closed without merging" about work that in fact shipped writes
  // a shortfall against a delivered goal.
  const text = deliveredWorkBriefing([pr({ state: undefined, merged: false })]);
  assert.match(text, /never recorded how it ended/);
  assert.doesNotMatch(text, /closed without merging/);
});

test('over the cap the oldest go, and the count that went is named', () => {
  const many = Array.from({ length: 30 }, (_, i) => pr({ number: i + 1, id: `pr${i}` }));
  const text = deliveredWorkBriefing(many);
  // Named, never silently truncated: an assessor reading a trimmed list as the
  // whole one concludes from the absence of a pull request that was merely cut.
  assert.match(text, /5 older pull requests of this goal were trimmed to fit/);
  assert.equal(text.split('\n').filter((l) => /^- #/.test(l)).length, 25);
});

// -- through the dispatch that carries it ------------------------------------

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

/** One code dispatch on the given origin, straight through the executor. */
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
  const task = system.store.listTasks().find((t) => t.originRef === originRef);
  assert.ok(task, 'nothing was dispatched, so there is no prompt to read');
  return system.store.getTask(task.id)?.prompt ?? '';
}

/** The goal's plan, with its one part sitting on a merged pull request. */
function partOnPr(system: System, prNumber: number): PlanPart {
  const plan = planWithOnePart(system.store, 12);
  const part = system.store.listPlanParts(plan.id)[0]!;
  return system.store.updatePlanPart(part.id, { status: 'merged', prNumber, branch: 'issue/12' })!;
}

test('an assessor is told where the goal’s merges are, and only this goal’s', async () => {
  const system = build();
  try {
    system.store.archiveClosedPrs([
      pr(),
      pr({ id: 'pr41', number: 41, title: 'Somebody else', branch: 'issue/99', mergeCommitSha: 'dddd999' }),
    ]);
    partOnPr(system, 40);

    const prompt = await dispatch(system, 'issue:12:assess');

    // Appended, never interpolated: the rendered template is still there whole,
    // with the index after it. A `{delivered}` token would have been dropped in
    // silence by every operator override written before this existed.
    assert.match(prompt, /^THE TASK ITSELF/);
    assert.match(prompt, /#40 — merged/, "the goal's own merged pull request");
    assert.match(prompt, /abc1234/, 'and the commit its merge left, which git cannot recover from the branch');
    // Another goal's merge is another goal's: the archive is the whole table, and
    // the scoping is `issueForPr` plus the plan's own part rows.
    assert.doesNotMatch(prompt, /dddd999/);
  } finally {
    system.store.close();
  }
});

test('a part’s pull request is the goal’s even where the branch convention does not say so', async () => {
  // The arm `issueForPr` cannot supply: a part whose branch follows nothing and
  // whose pull request the provider never linked is still the goal's, and the plan
  // row is the stored fact that says so.
  const system = build();
  try {
    system.store.archiveClosedPrs([
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
  // Keyed on the exact assess origin, `retroBriefing`'s scoping: this is an account
  // of a run the harness believes is over, and in front of a part agent still
  // writing that run's code it is a stale reading of work in flight.
  const system = build();
  try {
    system.store.archiveClosedPrs([pr()]);
    const prompt = await dispatch(system, 'issue:12:part:whole');
    assert.doesNotMatch(prompt, /abc1234/);
    assert.doesNotMatch(prompt, /Where this goal’s pull requests are/);
  } finally {
    system.store.close();
  }
});

test('the assess origin is read in one place', () => {
  // A second regex would be free to disagree about which refs are assessments, and
  // the reader that got it wrong would hand the record to an agent working
  // something else.
  assert.equal(assessIssueNumber('issue:12:assess'), 12);
  assert.equal(assessIssueNumber('issue:12'), null);
  assert.equal(assessIssueNumber('issue:12:part:assess'), null);
  assert.equal(assessIssueNumber('pr:12:assess'), null);
});
