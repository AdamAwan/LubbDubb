import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeConnector } from '../src/connector/fakeConnector.js';
import { readFileSync, readdirSync } from 'node:fs';
import { buildStacks } from '../src/stacks/stack.js';
import { retargetsFor } from '../src/prRetarget.js';
import type { Plan, PlanPart, PullRequest } from '../src/types.js';

function connector(): FakeConnector {
  return new FakeConnector(new Store(':memory:'));
}

test('the sink can open a pull request and it appears in the world', async () => {
  const c = connector();
  const result = await c.createPullRequest({
    branch: 'issue/12/schema',
    base: 'main',
    title: '#12 [1/2] feat(store): schema',
    body: 'part of #12',
  });
  assert.equal(result.ok, true);
  assert.ok(result.ref, 'the created PR number comes back for the audit log');

  const world = await c.getState();
  const pr = world.pullRequests.find((p) => p.branch === 'issue/12/schema');
  assert.ok(pr, 'the opened PR is in the world');
  assert.equal(pr.baseBranch, 'main');
  assert.equal(pr.title, '#12 [1/2] feat(store): schema');
  assert.equal(String(pr.number), result.ref);
});

test('an opened pull request can be retitled and retargeted in place', async () => {
  const c = connector();
  const created = await c.createPullRequest({
    branch: 'issue/12/cursor',
    base: 'issue/12/schema',
    title: 'wip',
    body: '',
  });
  const number = Number(created.ref);

  await c.setPullTitle({ prNumber: number, title: '#12 [2/2] feat(store): cursor' });
  await c.setPullBase({ prNumber: number, base: 'main' });

  const world = await c.getState();
  const pr = world.pullRequests.find((p) => p.number === number);
  assert.ok(pr);
  assert.equal(pr.title, '#12 [2/2] feat(store): cursor');
  assert.equal(pr.baseBranch, 'main', 'retargeting is what a merged rung beneath this one causes');
});

test('opened pull requests take distinct numbers', async () => {
  const c = connector();
  const a = await c.createPullRequest({ branch: 'a', base: 'main', title: 'a', body: '' });
  const b = await c.createPullRequest({ branch: 'b', base: 'main', title: 'b', body: '' });
  assert.notEqual(a.ref, b.ref);
});

// ---------------------------------------------------------------------------
// The derived stack model
// ---------------------------------------------------------------------------

function pr(over: Partial<PullRequest> & { number: number; branch: string }): PullRequest {
  return {
    id: `pr_${over.number}`,
    title: `PR ${over.number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    baseBranch: 'main',
    ...over,
  };
}

function part(over: Partial<PlanPart> & { slug: string; planId: string }): PlanPart {
  return {
    id: `${over.planId}:${over.slug}`,
    seq: 1,
    title: over.slug,
    scope: '',
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    touches: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'dispatched',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...over,
  };
}

function plan(over: Partial<Plan> & { id: string; originRef: string }): Plan {
  return {
    title: 'Ticket sync rewrite',
    status: 'active',
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...over,
  };
}

test('a hand-made chain is a stack, with no plan behind it', () => {
  const stacks = buildStacks(
    [
      pr({ number: 38, branch: 'issue/164/prune', baseBranch: 'main' }),
      pr({ number: 39, branch: 'issue/164/reclaim', baseBranch: 'issue/164/prune' }),
    ],
    [],
    [],
    'main',
  );
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0]?.planId, null, 'no plan produced this one');
  assert.equal(stacks[0]?.issueNumber, null);
  assert.deepEqual(
    stacks[0]?.rungs.map((r) => [r.prNumber, r.position]),
    [
      [38, 1],
      [39, 2],
    ],
    'bottom-first',
  );
});

test('a plan adopts the stack its parts opened', () => {
  const stacks = buildStacks(
    [
      pr({ number: 44, branch: 'issue/182/migrations', baseBranch: 'main' }),
      pr({ number: 45, branch: 'issue/182/cursor', baseBranch: 'issue/182/migrations' }),
    ],
    [plan({ id: 'p1', originRef: 'issue:182' })],
    [
      part({ planId: 'p1', slug: 'migrations', prNumber: 44 }),
      part({ planId: 'p1', slug: 'cursor', prNumber: 45, seq: 2 }),
    ],
    'main',
  );
  assert.equal(stacks[0]?.planId, 'p1');
  assert.equal(stacks[0]?.issueNumber, 182);
  assert.equal(stacks[0]?.issueTitle, 'Ticket sync rewrite');
  assert.deepEqual(
    stacks[0]?.rungs.map((r) => r.partSlug),
    ['migrations', 'cursor'],
  );
});

test('a lone PR is not a stack of one', () => {
  assert.deepEqual(buildStacks([pr({ number: 5, branch: 'feat/x', baseBranch: 'main' })], [], [], 'main'), []);
});

test('an ignored rung does not put a hole in the chain', () => {
  // The caller passes the *unfiltered* open list for exactly this reason: filtering
  // the middle rung out would leave the top one reading as its own bottom.
  const stacks = buildStacks(
    [
      pr({ number: 44, branch: 'a', baseBranch: 'main' }),
      pr({ number: 45, branch: 'b', baseBranch: 'a', labels: ['lubbdubb-ignore'] }),
      pr({ number: 46, branch: 'c', baseBranch: 'b' }),
    ],
    [],
    [],
    'main',
  );
  assert.equal(stacks.length, 1);
  assert.deepEqual(
    stacks[0]?.rungs.map((r) => r.prNumber),
    [44, 45, 46],
  );
});

test('a merged rung is not a base — the chain stops rather than resurrecting it', () => {
  const stacks = buildStacks(
    [
      pr({ number: 44, branch: 'a', baseBranch: 'main', merged: true }),
      pr({ number: 45, branch: 'b', baseBranch: 'a' }),
    ],
    [],
    [],
    'main',
  );
  assert.deepEqual(stacks, [], 'PR 45 is a lone PR once its base has merged');
});

test('a cycle in the base edges terminates rather than hanging the pulse', () => {
  const stacks = buildStacks(
    [pr({ number: 1, branch: 'a', baseBranch: 'b' }), pr({ number: 2, branch: 'b', baseBranch: 'a' })],
    [],
    [],
    'main',
  );
  // Neither is a bottom, so nothing is walked at all — the point is that it returns.
  assert.deepEqual(stacks, []);
});

test('the stack model is a lens: nothing in the dispatcher reads it', () => {
  const dispatcherFiles = srcFiles('src/dispatcher');
  for (const file of dispatcherFiles) {
    assert.ok(
      !readFileSync(file, 'utf8').includes('stacks/'),
      `${file} must not read the stack model — a rule consulting it is a second opinion about a gate elsewhere`,
    );
  }
  assert.ok(dispatcherFiles.length > 0, 'the walk must actually have files to check');
});

test('the stack model has exactly one importer, and it is the snapshot', () => {
  const importers = srcFiles('src')
    .filter((f) => !f.startsWith('src/stacks/'))
    .filter((f) => readFileSync(f, 'utf8').includes('stacks/stack.js'));
  // `src/wire.ts` is the second, and it is a declaration: it names {@link Stack}
  // as the shape `/api/state` ships and imports no value at all (asserted in
  // `test/wireContract.test.ts`). The one importer that *builds* stacks is still
  // the snapshot.
  assert.deepEqual(importers, ['src/server/stateSnapshot.ts', 'src/wire.ts'], 'the stack model must stay cockpit-only');
});

/** Every `.ts` under a source directory, recursively, as repo-relative paths. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Retarget on merge — the half GitHub does for us and Azure does not
// ---------------------------------------------------------------------------

test('a rung whose parent merged is retargeted onto the parent’s own base', () => {
  const out = retargetsFor(
    [pr({ number: 45, branch: 'issue/182/cursor', baseBranch: 'issue/182/migrations' })],
    [pr({ number: 44, branch: 'issue/182/migrations', baseBranch: 'main', state: 'merged' })],
    'main',
  );
  assert.deepEqual(out, [{ prNumber: 45, base: 'main' }]);
});

test('a taller stack retargets onto the next rung down, not straight to the default branch', () => {
  const out = retargetsFor(
    [pr({ number: 46, branch: 'c', baseBranch: 'b' })],
    [pr({ number: 45, branch: 'b', baseBranch: 'a', state: 'merged' })],
    'main',
  );
  assert.deepEqual(out, [{ prNumber: 46, base: 'a' }]);
});

test('retargeting is idempotent — a rung already on the right base yields nothing', () => {
  const out = retargetsFor(
    [pr({ number: 45, branch: 'b', baseBranch: 'main' })],
    [pr({ number: 44, branch: 'a', baseBranch: 'main', state: 'merged' })],
    'main',
  );
  assert.deepEqual(out, []);
});

test('an abandoned parent strands its child deliberately rather than rebasing it', () => {
  // The work beneath never landed, so retargeting would silently drop the premise
  // this rung was built on. That is a human's call.
  const out = retargetsFor(
    [pr({ number: 45, branch: 'b', baseBranch: 'a' })],
    [pr({ number: 44, branch: 'a', baseBranch: 'main', state: 'closed' })],
    'main',
  );
  assert.deepEqual(out, []);
});

test('nothing recently closed means no work and no reads', () => {
  assert.deepEqual(retargetsFor([pr({ number: 45, branch: 'b', baseBranch: 'a' })], [], 'main'), []);
});
