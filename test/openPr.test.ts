import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenPr, type OpenPrContext } from '../src/mcp/openPr.js';
import type { Issue, Plan, PlanPart } from '../src/types.js';

function issue(number: number, title = 'Ticket sync rewrite'): Issue {
  return { id: `issue_${number}`, number, title, body: '', state: 'open', labels: [], linkedPrNumber: null };
}

function part(over: Partial<PlanPart> & { slug: string; seq: number }): PlanPart {
  return {
    id: `p1:${over.slug}`,
    planId: 'p1',
    title: over.slug,
    scope: '',
    rationale: null,
    acceptance: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'dispatched',
    blockedReason: null,
    taskId: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...over,
  };
}

const plan: Plan = {
  id: 'p1',
  originRef: 'issue:182',
  title: 'Ticket sync rewrite',
  status: 'active',
  reason: null,
  risks: null,
  outOfScope: null,
  document: null,
  discussing: false,
  statusCommentRef: null,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
};

function ctx(over: Partial<OpenPrContext> = {}): OpenPrContext {
  return { issues: [issue(182)], plan: null, parts: [], defaultBranch: 'main', ...over };
}

test('a pickup origin opens one PR onto the default branch, with no stack position', () => {
  const target = resolveOpenPr('issue:182', ctx());
  assert.deepEqual(target, {
    issueNumber: 182,
    issueTitle: 'Ticket sync rewrite',
    branch: 'issue/182',
    base: 'main',
    position: 1,
    total: 1,
  });
});

test('a part origin stacks on the dependency it declares', () => {
  const parts = [
    part({ slug: 'migrations', seq: 1 }),
    part({ slug: 'cursor', seq: 2, dependsOn: ['migrations'], branch: 'issue/182/cursor' }),
  ];
  const target = resolveOpenPr('issue:182:part:cursor', ctx({ plan, parts }));
  assert.deepEqual(target, {
    issueNumber: 182,
    issueTitle: 'Ticket sync rewrite',
    branch: 'issue/182/cursor',
    base: 'issue/182/migrations',
    position: 2,
    total: 2,
  });
});

test('a part depending on nothing is the bottom rung and targets the default branch', () => {
  const parts = [part({ slug: 'migrations', seq: 1 }), part({ slug: 'cursor', seq: 2, dependsOn: ['migrations'] })];
  const target = resolveOpenPr('issue:182:part:migrations', ctx({ plan, parts }));
  assert.ok(!('error' in target));
  assert.equal(target.base, 'main');
  assert.equal(target.position, 1);
});

test('a settled dependency is not stacked on — the rejoin targets the default branch', () => {
  const parts = [
    part({ slug: 'migrations', seq: 1, status: 'merged' }),
    part({ slug: 'cursor', seq: 2, dependsOn: ['migrations'] }),
  ];
  const target = resolveOpenPr('issue:182:part:cursor', ctx({ plan, parts }));
  assert.ok(!('error' in target));
  assert.equal(target.base, 'main', 'nothing is open to stack on once the dependency has merged');
});

test('a retired part is not a target, and does not count toward the total', () => {
  const parts = [
    part({ slug: 'migrations', seq: 1 }),
    part({ slug: 'dropped', seq: 2, status: 'retired' }),
    part({ slug: 'cursor', seq: 3, dependsOn: ['migrations'] }),
  ];
  const live = resolveOpenPr('issue:182:part:cursor', ctx({ plan, parts }));
  assert.ok(!('error' in live));
  assert.equal(live.total, 2);
  assert.equal(live.position, 2);

  const retired = resolveOpenPr('issue:182:part:dropped', ctx({ plan, parts }));
  assert.ok('error' in retired);
});

test('every origin that is not doing an issue’s work is refused by name', () => {
  for (const origin of ['pr:42:ci', 'issue:182:plan', 'issue:182:assay', 'issue:182:assess', 'issue:182:retro', 'job:7']) {
    const target = resolveOpenPr(origin, ctx({ plan, parts: [part({ slug: 'cursor', seq: 1 })] }));
    assert.ok('error' in target, `${origin} must not be able to open a pull request`);
    assert.match(target.error, /open_pr is for/);
  }
});

test('an agent with no origin at all is refused rather than defaulted', () => {
  const target = resolveOpenPr(null, ctx());
  assert.ok('error' in target);
});

test('a part origin whose issue has no plan is refused rather than guessed onto a branch', () => {
  const target = resolveOpenPr('issue:182:part:cursor', ctx());
  assert.ok('error' in target);
  assert.match(target.error, /no plan/);
});
