import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import type { PullRequest } from '../src/types.js';
import { landedCount, landingFor, landingReadiness, rungFault, settleLandings } from '../src/stacks/landing.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

function build(sink: ActionSink, overrides: Record<string, unknown> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink,
    errorMirror: () => {},
  });
}

function countingSink(fail = false): ActionSink & { merges: number[] } {
  const merges: number[] = [];
  return {
    merges,
    canCloseIssue: () => false,
    canClosePr: () => false,
    closePr: (): never => {
      throw new Error('closePr is not scripted in this test');
    },
    canResolvePrThread: () => false,
    resolvePrThread: (): never => {
      throw new Error('resolvePrThread is not scripted in this test');
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    async mergePr({ prNumber }) {
      merges.push(prNumber);
      if (fail) throw new Error('merge conflict');
      return { ok: true, ref: `pr:${prNumber}` };
    },
    async postPrReply() {
      return { ok: true };
    },
    async setPrLabel() {
      return { ok: true };
    },
    async setIssueLabel() {
      return { ok: true };
    },
    async setWorkItemState() {
      return { ok: true };
    },
    async linkWorkItem() {
      return { ok: true };
    },
    async createIssue() {
      return { ok: true as const, ref: 'issue:1' };
    },
    async upsertIssueComment() {
      return { ok: true };
    },
    async createPullRequest() {
      return { ok: true };
    },
    async setPullTitle() {
      return { ok: true };
    },
    async setPullBase() {
      return { ok: true };
    },
    async updatePrBranch() {
      return { ok: true };
    },
    async requeueCiCheck() {
      return { ok: true };
    },
    async deleteBranch() {
      return { ok: true };
    },
  };
}

function rung(number: number, base: string, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr-${number}`,
    number,
    title: `rung ${number}`,
    branch: `issue/12/r${number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    approved: true,
    mergeable: true,
    baseBranch: base,
    mergeableState: 'clean',
    merged: false,
    ...over,
  };
}

function mergePlan(prNumber: number): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'merge_pr',
        prNumber,
        method: 'squash',
        confidence: 0.1,
        reason: `PR #${prNumber} is green, approved and mergeable`,
      },
    ],
  } as unknown as DispatchResult;
}

test('a standing intent authorizes a rung’s merge, through the proposal path and named as itself', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.landings.land('stack:1', [1, 2, 3]);

  await system.executor.execute('cyc_1', mergePlan(1));

  assert.deepEqual(sink.merges, [1], 'the bottom rung merged, exactly once');

  const proposal = system.store.escalations.listProposals().find((p) => p.ref === 'pr:1:merge');
  assert.ok(proposal, 'a merge proposal was created for the rung');
  assert.equal(proposal.status, 'accepted');
  assert.equal(proposal.decidedBy, 'stack_landing', 'the decider is the landing, not auto-send');
  assert.match(proposal.note ?? '', /you authorized landing stack:1 \(3 pull requests\)/);

  const decision = system.store.decisions.listDecisions().find((d) => d.action.type === 'merge_pr');
  assert.ok(decision);
  assert.equal(decision.outcome, 'executed');
  assert.match(decision.detail, /authorized by you, landing the stack/);
});

test('a rung the operator never authorized is not merged by someone else’s intent', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.landings.land('stack:1', [1, 2]);

  await system.executor.execute('cyc_1', mergePlan(9));

  assert.deepEqual(sink.merges, [], 'nothing went out');
  const proposal = system.store.escalations.listProposals().find((p) => p.ref === 'pr:9:merge');
  assert.equal(proposal?.status, 'pending', 'it was put to the operator instead');
});

test('a rung that goes red stops the intent, and no later merge is authorized', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.landings.land('stack:1', [1, 2]);

  system.landings.settle({
    pullRequests: [rung(2, 'main', { ciStatus: 'failing' })],
    closedPullRequests: [rung(1, 'main', { merged: true, state: 'merged' })],
  });

  const landing = system.store.landings.listStackLandings()[0];
  assert.equal(landing?.status, 'stopped');
  assert.match(landing?.reason ?? '', /#2 CI failing/);

  const escalation = system.store.escalations.listOpenEscalations().find((e) => e.context.stackLandingStopped === true);
  assert.ok(escalation, 'the operator was told the chain stopped');
  assert.match(escalation.prompt, /has stopped: #2 CI failing/);

  await system.executor.execute('cyc_2', mergePlan(2));
  assert.deepEqual(sink.merges, [], 'nothing merged on a stopped intent');
  assert.equal(system.store.escalations.listProposals().find((p) => p.ref === 'pr:2:merge')?.status, 'pending');
});

test('a merge that fails at the sink stops the intent rather than retrying forever', async () => {
  const sink = countingSink(true);
  const system = build(sink);
  system.landings.land('stack:1', [1, 2]);

  await system.executor.execute('cyc_1', mergePlan(1));

  assert.deepEqual(sink.merges, [1], 'it was attempted');
  assert.equal(system.store.landings.listStackLandings()[0]?.status, 'stopped');
  assert.match(system.store.landings.listStackLandings()[0]?.reason ?? '', /merging #1 failed: merge conflict/);
});

test('the whole chain merging ends the intent, with nothing left standing', () => {
  const system = build(countingSink());
  system.landings.land('stack:1', [1, 2]);

  system.landings.settle({
    pullRequests: [],
    closedPullRequests: [
      rung(1, 'main', { merged: true, state: 'merged' }),
      rung(2, 'main', { merged: true, state: 'merged' }),
    ],
  });

  assert.equal(system.store.landings.listStackLandings()[0]?.status, 'landed');
  assert.equal(system.store.landings.listStandingLandings().length, 0);
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'a chain that simply finished asks nothing');
});

test('the intent survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-landing-'));
  const dbPath = join(dir, 'store.db');
  try {
    const first = build(countingSink(), { dbPath });
    first.landings.land('stack:1', [1, 2, 3]);
    first.store.close();

    const sink = countingSink();
    const second = build(sink, { dbPath });
    const standing = second.store.landings.listStandingLandings();
    assert.equal(standing.length, 1, 'the authorization outlived the process');
    assert.deepEqual(standing[0]?.rungs, [1, 2, 3]);

    await second.executor.execute('cyc_1', mergePlan(2));
    assert.deepEqual(sink.merges, [2]);
    second.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the button is withheld until every rung is clear, and "behind" does not withhold it', () => {
  assert.deepEqual(landingReadiness([rung(1, 'main'), rung(2, 'issue/12/r1', { mergeableState: 'behind' })]), {
    offer: true,
    blockedBy: null,
  });
  assert.deepEqual(landingReadiness([rung(1, 'main'), rung(2, 'issue/12/r1', { mergeableState: 'blocked' })]), {
    offer: false,
    blockedBy: '#2 merge blocked (required checks/reviews)',
  });

  assert.deepEqual(landingReadiness([rung(1, 'main'), rung(2, 'issue/12/r1', { ciStatus: 'failing' })]), {
    offer: false,
    blockedBy: '#2 CI failing',
  });
  assert.equal(landingReadiness([rung(1, 'main', { approved: false })]).blockedBy, '#1 not approved');
  assert.equal(
    landingReadiness([rung(1, 'main', { mergeableState: 'dirty' })]).blockedBy,
    '#1 conflicts with its base',
  );
  assert.equal(
    landingReadiness([rung(1, 'main', { unresolvedComments: [{ id: 'c', author: 'r', body: '?', handled: false }] })])
      .blockedBy,
    '#1 has 1 unresolved comment',
  );
});

test('pending checks wait; they do not stop a chain that is already landing', () => {
  assert.equal(rungFault(rung(2, 'main', { ciStatus: 'pending' })), null);
  assert.equal(landingReadiness([rung(2, 'main', { ciStatus: 'pending' })]).offer, false);

  const standing = {
    id: 'land_1',
    ref: 'stack:1',
    rungs: [1, 2],
    status: 'standing' as const,
    reason: null,
    createdAt: 'now',
    updatedAt: 'now',
  };
  assert.deepEqual(
    settleLandings([standing], {
      pullRequests: [rung(2, 'main', { ciStatus: 'pending' })],
      closedPullRequests: [rung(1, 'main', { merged: true, state: 'merged' })],
    }),
    [],
    'a rung whose checks have not reported is neither finished nor faulted',
  );

  assert.deepEqual(
    settleLandings([standing], { pullRequests: [], closedPullRequests: [rung(1, 'main', { state: 'closed' })] })[0]
      ?.reason,
    '#1 is no longer open and nothing says it merged',
  );
});

test('a merged rung ageing out of the closed-PR window does not stop the chain', () => {
  const system = build(countingSink());
  const landing = system.landings.land('stack:1', [1, 2, 3]);
  system.store.graph.recordWorkGraph([
    { ref: 'pr:1', kind: 'pr', title: 'rung 1', status: 'merged', terminal: true, parentRef: null },
  ]);

  const world = {
    pullRequests: [rung(2, 'main'), rung(3, 'issue/12/r2')],
    closedPullRequests: [],
  };
  system.landings.settle(world);

  assert.equal(system.store.landings.listStackLandings()[0]?.status, 'standing', 'the chain is still landing');
  assert.equal(
    system.store.escalations.listOpenEscalations().length,
    0,
    'and nothing false was put in front of the operator',
  );
  assert.equal(
    landedCount(landing, { ...world, merged: system.store.graph.mergedPrs() }),
    1,
    '"landing 1 of 3" counts up, never back down as rungs age out',
  );

  system.landings.settle({ pullRequests: [rung(3, 'issue/12/r2')], closedPullRequests: [] });
  assert.equal(system.store.landings.listStackLandings()[0]?.status, 'stopped');
  assert.match(system.store.landings.listStackLandings()[0]?.reason ?? '', /#2 is no longer open/);
});

test('the durable record alone finishes a chain the world no longer mentions', () => {
  const standing = {
    id: 'land_1',
    ref: 'stack:1',
    rungs: [1, 2],
    status: 'standing' as const,
    reason: null,
    createdAt: 'now',
    updatedAt: 'now',
  };
  assert.deepEqual(
    settleLandings([standing], { pullRequests: [], closedPullRequests: [], merged: new Set([1, 2]) })[0]?.status,
    'landed',
  );
  assert.deepEqual(
    settleLandings([standing], {
      pullRequests: [],
      closedPullRequests: [rung(2, 'main', { merged: true, state: 'merged' })],
      merged: new Set([1]),
    })[0]?.status,
    'landed',
  );
});

test('a second click supersedes the first rather than racing it', () => {
  const system = build(countingSink());
  const first = system.landings.land('stack:1', [1, 2]);
  system.landings.land('stack:1', [1, 2, 3]);

  assert.equal(system.store.landings.getStackLanding(first.id)?.status, 'revoked');
  const standing = system.store.landings.listStandingLandings();
  assert.equal(standing.length, 1, 'exactly one authorization covers a chain');
  assert.deepEqual(standing[0]?.rungs, [1, 2, 3]);
});

test('nothing is settled from a world a provider could not read', () => {
  const system = build(countingSink());
  const landing = system.landings.land('stack:1', [1, 2, 3]);
  const open = [rung(1, 'main'), rung(2, 'issue/12/r1'), rung(3, 'issue/12/r2')];

  system.landings.settle({ pullRequests: open, closedPullRequests: [] });
  assert.equal(
    system.store.landings.getStackLanding(landing.id)?.status,
    'standing',
    'a healthy pulse leaves it standing',
  );

  system.landings.settle({ pullRequests: [], closedPullRequests: [], staleSources: ['github'] });

  const after = system.store.landings.getStackLanding(landing.id);
  assert.equal(after?.status, 'standing', 'an authorization is not revoked by a world nobody could read');
  assert.equal(after?.reason, null);
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'and the operator is told nothing false');

  assert.deepEqual(
    settleLandings([landing], { pullRequests: [], staleSources: ['github'] }),
    [],
    'the landed arm skips a stale world as well',
  );

  system.landings.settle({ pullRequests: open, closedPullRequests: [] });
  assert.equal(
    system.store.landings.getStackLanding(landing.id)?.status,
    'standing',
    'and it is intact when the world is',
  );
});

test('the stop control survives the chain dropping below two rungs', async () => {
  const system = build(countingSink(), { auth: { enabled: false } });
  system.connector.inject({ kind: 'new_pr', number: 1, title: 'rung 1', branch: 'issue/12/r1' });
  system.connector.inject({
    kind: 'new_pr',
    number: 2,
    title: 'rung 2',
    branch: 'issue/12/r2',
    baseBranch: 'issue/12/r1',
  });
  for (const n of [1, 2]) {
    system.connector.inject({ kind: 'ci_passed', prNumber: n });
    system.connector.inject({ kind: 'pr_approved', prNumber: n });
    system.connector.inject({ kind: 'pr_mergeable', prNumber: n, mergeable: true, mergeableState: 'clean' });
  }

  const { app } = await buildApp(system);
  try {
    const landed = await app.inject({ method: 'POST', url: '/api/stacks/stack:1/land' });
    assert.equal(landed.statusCode, 200);
    assert.deepEqual(system.store.landings.listStandingLandings()[0]?.rungs, [1, 2]);

    system.connector.inject({ kind: 'pr_closed', prNumber: 1, merged: true });
    system.store.world.setWorldBaseline(await system.connector.getState());
    assert.equal(system.store.landings.listStandingLandings().length, 1, 'the authorization outlived the chain');

    const shipped = (await buildStateSnapshot(system)).stackLandings;
    assert.equal(shipped.length, 1);
    assert.equal(shipped[0]?.landing?.status, 'standing');
    assert.equal(shipped[0]?.offer, false, 'there is no chain left to land, only one to stop');

    const stopped = await app.inject({ method: 'DELETE', url: '/api/stacks/stack:1/land' });
    assert.equal(stopped.statusCode, 200, 'the ref the operator was shown still calls it off');
    assert.equal(system.store.landings.listStackLandings()[0]?.status, 'revoked');
    assert.equal(system.store.landings.listStandingLandings().length, 0, 'and nothing authorizes #2 any more');
  } finally {
    await app.close();
  }
});

test('a stack ref naming any rung of a standing intent calls it off', async () => {
  const system = build(countingSink(), { auth: { enabled: false } });
  system.landings.land('stack:1', [1, 2]);

  const { app } = await buildApp(system);
  try {
    const stopped = await app.inject({ method: 'DELETE', url: '/api/stacks/stack:2/land' });
    assert.equal(stopped.statusCode, 200);
    assert.equal(system.store.landings.listStackLandings()[0]?.status, 'revoked');

    const none = await app.inject({ method: 'DELETE', url: '/api/stacks/stack:9/land' });
    assert.equal(none.statusCode, 404);
    assert.equal(none.json<{ error: string }>().error, 'nothing standing for stack:9');
  } finally {
    await app.close();
  }
});

test('the button is never offered over a rung the merge rule will refuse forever', () => {
  const ciStatuses: PullRequest['ciStatus'][] = ['passing', 'failing', 'pending'];
  const approvals = [true, false, undefined];
  const mergeables = [true, false, undefined];
  const states: PullRequest['mergeableState'][] = ['clean', 'behind', 'blocked', 'dirty', 'unknown', undefined];

  const stalls: string[] = [];
  for (const ciStatus of ciStatuses)
    for (const approved of approvals)
      for (const mergeable of mergeables)
        for (const mergeableState of states) {
          const pr = rung(1, 'main', { ciStatus, approved, mergeable, mergeableState });
          const mergeReady =
            pr.ciStatus === 'passing' &&
            pr.approved === true &&
            pr.mergeable === true &&
            pr.mergeableState !== 'behind' &&
            pr.mergeableState !== 'blocked' &&
            pr.mergeableState !== 'dirty' &&
            pr.unresolvedComments.every((c) => c.handled);

          if (!landingReadiness([pr]).offer || mergeReady) continue;
          if (mergeableState === 'behind') continue;
          stalls.push(
            `ci=${ciStatus} approved=${String(approved)} mergeable=${String(mergeable)} state=${String(mergeableState)}`,
          );
        }

  assert.deepEqual(stalls, [], 'every offered-but-unmergeable rung state must clear itself');
});

test('a blocked rung and an uncomputed one each say which they are', () => {
  assert.equal(
    landingReadiness([rung(1, 'main', { mergeableState: 'blocked' })]).blockedBy,
    '#1 merge blocked (required checks/reviews)',
  );
  assert.equal(
    landingReadiness([rung(1, 'main', { mergeable: undefined })]).blockedBy,
    '#1 — the provider reports no mergeable state',
    'absent is the provider not having said, which is not the same as a conflict',
  );
  assert.equal(
    landingReadiness([rung(1, 'main', { mergeable: false })]).blockedBy,
    '#1 conflicts with its base',
    'and `false` keeps its own wording',
  );

  assert.equal(landingReadiness([rung(1, 'main', { mergeableState: 'behind' })]).offer, true);
});

test('an intent over one path of a fork is not drawn against the other', () => {
  const system = build(countingSink());
  const landing = system.landings.land('stack:1:2', [1, 2]);
  const open = new Set([1, 2, 3]);

  assert.equal(landingFor([1, 2], [landing], open)?.id, landing.id, 'the path it authorizes');
  assert.equal(landingFor([1, 3], [landing], open), null, 'and not the sibling, which shares only the bottom');

  assert.equal(landingFor([2], [landing], new Set([2, 3]))?.id, landing.id, '"landing 1 of 2" survives the merge');
});
