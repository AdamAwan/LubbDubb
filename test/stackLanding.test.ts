import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import type { PullRequest } from '../src/types.js';
import { landingReadiness, rungFault, settleLandings } from '../src/stacks/landing.js';

/**
 * "Land the stack": one click that authorizes a whole chain, and then keeps
 * authorizing each rung's merge as rule `pr-merge-ready` proposes it, cycle after
 * cycle.
 *
 * The three things worth holding are the three that make it safe rather than
 * merely convenient: the intent accepts a rung's merge through the *same*
 * `runAuthorized` path a human accept takes, it stops the moment a rung it
 * authorized goes red, and it survives a restart.
 */

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

/** A sink that records the merges that actually went out, and can refuse them. */
function countingSink(fail = false): ActionSink & { merges: number[] } {
  const merges: number[] = [];
  return {
    merges,
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
    async deleteBranch() {
      return { ok: true };
    },
  };
}

/** A green, approved, conflict-free rung — what every rung looks like at the click. */
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

/** The one merge action rule `pr-merge-ready` emits for whichever rung is bottom. */
function mergePlan(prNumber: number): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'merge_pr',
        prNumber,
        method: 'squash',
        // Below any threshold, so nothing here can be mistaken for auto-send
        // having done the work: only the standing intent can authorize this.
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

  // Not a second route: the act went out as an accepted `merge` proposal, which is
  // the only way a merge ever happens.
  const proposal = system.store.listProposals().find((p) => p.ref === 'pr:1:merge');
  assert.ok(proposal, 'a merge proposal was created for the rung');
  assert.equal(proposal.status, 'accepted');
  assert.equal(proposal.decidedBy, 'stack_landing', 'the decider is the landing, not auto-send');
  assert.match(proposal.note ?? '', /you authorized landing stack:1 \(3 pull requests\)/);

  // And the audit row says who, in the operator's terms.
  const decision = system.store.listDecisions().find((d) => d.action.type === 'merge_pr');
  assert.ok(decision);
  assert.equal(decision.outcome, 'executed');
  assert.match(decision.detail, /authorized by you, landing the stack/);
});

test('a rung the operator never authorized is not merged by someone else’s intent', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.landings.land('stack:1', [1, 2]);

  // #9 is a perfectly merge-ready PR that simply was not in the chain the operator
  // read. The intent's scope is its rungs, so it authorizes nothing here.
  await system.executor.execute('cyc_1', mergePlan(9));

  assert.deepEqual(sink.merges, [], 'nothing went out');
  const proposal = system.store.listProposals().find((p) => p.ref === 'pr:9:merge');
  assert.equal(proposal?.status, 'pending', 'it was put to the operator instead');
});

test('a rung that goes red stops the intent, and no later merge is authorized', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.landings.land('stack:1', [1, 2]);

  // Rung 1 lands; rung 2 is retargeted onto main and its checks fail on the new base.
  system.landings.settle({
    pullRequests: [rung(2, 'main', { ciStatus: 'failing' })],
    closedPullRequests: [rung(1, 'main', { merged: true, state: 'merged' })],
  });

  const landing = system.store.listStackLandings()[0];
  assert.equal(landing?.status, 'stopped');
  assert.match(landing?.reason ?? '', /#2 CI failing/);

  // Surfaced, not merely recorded — the rack head vanishes when a chain drops
  // below two rungs, so the inbox item is what makes the stop unmissable.
  const escalation = system.store.listOpenEscalations().find((e) => e.context.stackLandingStopped === true);
  assert.ok(escalation, 'the operator was told the chain stopped');
  assert.match(escalation.prompt, /has stopped: #2 CI failing/);

  // The whole point of stopping: the rung's merge, once it goes green again, is
  // put back to the operator rather than authorized by the intent they gave.
  await system.executor.execute('cyc_2', mergePlan(2));
  assert.deepEqual(sink.merges, [], 'nothing merged on a stopped intent');
  assert.equal(system.store.listProposals().find((p) => p.ref === 'pr:2:merge')?.status, 'pending');
});

test('a merge that fails at the sink stops the intent rather than retrying forever', async () => {
  const sink = countingSink(true);
  const system = build(sink);
  system.landings.land('stack:1', [1, 2]);

  await system.executor.execute('cyc_1', mergePlan(1));

  assert.deepEqual(sink.merges, [1], 'it was attempted');
  assert.equal(system.store.listStackLandings()[0]?.status, 'stopped');
  assert.match(system.store.listStackLandings()[0]?.reason ?? '', /merging #1 failed: merge conflict/);
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

  assert.equal(system.store.listStackLandings()[0]?.status, 'landed');
  assert.equal(system.store.listStandingLandings().length, 0);
  assert.equal(system.store.listOpenEscalations().length, 0, 'a chain that simply finished asks nothing');
});

test('the intent survives a restart', async () => {
  // `:memory:` cannot express a restart, so this is the one test that needs a file.
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-landing-'));
  const dbPath = join(dir, 'store.db');
  try {
    const first = build(countingSink(), { dbPath });
    first.landings.land('stack:1', [1, 2, 3]);
    first.store.close();

    const sink = countingSink();
    const second = build(sink, { dbPath });
    const standing = second.store.listStandingLandings();
    assert.equal(standing.length, 1, 'the authorization outlived the process');
    assert.deepEqual(standing[0]?.rungs, [1, 2, 3]);

    // Not merely readable — still authorizing, which is the half that matters.
    await second.executor.execute('cyc_1', mergePlan(2));
    assert.deepEqual(sink.merges, [2]);
    second.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the button is withheld until every rung is clear, and "behind" does not withhold it', () => {
  // The gate in front of the click. `behind`/`blocked` are excluded deliberately:
  // a rung is behind *because* the one under it has not landed, so counting it
  // would withhold the button from every real stack.
  assert.deepEqual(landingReadiness([rung(1, 'main'), rung(2, 'issue/12/r1', { mergeableState: 'behind' })]), {
    offer: true,
    blockedBy: null,
  });
  assert.deepEqual(landingReadiness([rung(1, 'main'), rung(2, 'issue/12/r1', { mergeableState: 'blocked' })]), {
    offer: true,
    blockedBy: null,
  });

  // Everything that is a fact about the *code* does withhold it, named in the
  // sentence the rack shows.
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
  // The asymmetry the feature lives or dies on. Retargeting a rung re-runs its
  // checks, so every rung passes through `pending` on its way to landing — a stop
  // there would stop every intent at its first success.
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

  // A rung that left the open set without merging is a stop: the chain cannot
  // finish, and claiming it landed would be the one lie this record must not tell.
  assert.deepEqual(
    settleLandings([standing], { pullRequests: [], closedPullRequests: [rung(1, 'main', { state: 'closed' })] })[0]
      ?.reason,
    '#1 is no longer open and nothing says it merged',
  );
});

test('a second click supersedes the first rather than racing it', () => {
  const system = build(countingSink());
  const first = system.landings.land('stack:1', [1, 2]);
  system.landings.land('stack:1', [1, 2, 3]);

  assert.equal(system.store.getStackLanding(first.id)?.status, 'revoked');
  const standing = system.store.listStandingLandings();
  assert.equal(standing.length, 1, 'exactly one authorization covers a chain');
  assert.deepEqual(standing[0]?.rungs, [1, 2, 3]);
});
