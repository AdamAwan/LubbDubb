import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prAttentionStatus, type PrAttentionContext } from '../src/prAttention.js';
import { awaitingReview } from '../src/prHealth.js';
import { Store } from '../src/store/store.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { CiPolicy } from '../src/ci/ciPolicy.js';
import type { ValidatedAction } from '../src/dispatcher/actions.js';
import type { Decision, Proposal, PullRequest, Task, WorldEvent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

const NOW = '2026-07-26T12:00:00.000Z';
const ago = (mins: number): string => new Date(Date.parse(NOW) - mins * 60_000).toISOString();

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p7',
    number: 7,
    title: 'Add the widget',
    branch: 'feat/widget',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function mergeReadyPr(over: Partial<PullRequest> = {}): PullRequest {
  return pr({ approved: true, mergeable: true, mergeableState: 'clean', ...over });
}

function ctx(over: Partial<PrAttentionContext> = {}): PrAttentionContext {
  return {
    openPrs: [],
    defaultBranch: 'main',
    watchLabel: '',
    tasks: [],
    proposals: [],
    recentDecisions: [],
    cooldown: DEFAULT_COOLDOWN,
    ci: { checks: [] },
    now: NOW,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Fix failing CI on PR #7',
    prompt: 'do it',
    branch: 'feat/widget',
    originRef: 'pr:7:ci',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: ago(5),
    updatedAt: ago(1),
    ...over,
  };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop_1',
    kind: 'merge',
    ref: 'pr:7:merge',
    status: 'pending',
    action: { type: 'merge_pr', prNumber: 7, method: 'squash', reason: 'green' } as Proposal['action'],
    note: null,
    decidedBy: null,
    decidedAt: null,
    escalationId: 'esc_1',
    createdAt: ago(30),
    ...over,
  };
}

function attempt(origin: string, at: string): Decision {
  return {
    id: `d_${origin}_${at}`,
    cycleId: 'cyc',
    action: {
      type: 'dispatch_code_agent',
      branch: 'feat/widget',
      title: 'x',
      prompt: 'x',
      originRef: origin,
      reason: 'x',
    },
    outcome: 'executed',
    detail: 'spawned',
    rule: null,
    createdAt: at,
  } as unknown as Decision;
}

test('a merged or abandoned PR is off the board', () => {
  assert.deepEqual(prAttentionStatus(pr({ merged: true }), ctx()), { status: 'done', reasons: ['merged'] });
  assert.deepEqual(prAttentionStatus(pr({ state: 'closed' }), ctx()), {
    status: 'done',
    reasons: ['closed without merging'],
  });
});

test('an untagged PR is a status of its own, and it wins over every signal', () => {
  const untagged = pr({
    ciStatus: 'failing',
    unresolvedComments: [{ id: 'c1', author: 'reviewer', body: 'hm', handled: false }],
  });
  const gate = { watchLabel: 'lubbdubb-watch' };
  const verdict = prAttentionStatus(untagged, ctx(gate));
  assert.equal(verdict.status, 'unwatched');
  assert.match(verdict.reasons[0]!, /lubbdubb-watch/);
  assert.notEqual(prAttentionStatus(pr({ ...untagged, labels: ['lubbdubb-watch'] }), ctx(gate)).status, 'unwatched');
  assert.notEqual(prAttentionStatus(untagged, ctx()).status, 'unwatched');
});

test('a pending proposal is named on the PR row, not deferred to the inbox', () => {
  const verdict = prAttentionStatus(mergeReadyPr(), ctx({ proposals: [proposal()] }));
  assert.equal(verdict.status, 'you');
  assert.match(verdict.reasons[0]!, /awaiting your accept\/reject of the merge \(prop_1\)/);
});

test('a pending reply draft counts too, and a proposal on another PR does not', () => {
  const reply = proposal({ id: 'prop_2', kind: 'reply_draft', ref: 'pr:7:comment:c1' });
  assert.equal(prAttentionStatus(mergeReadyPr(), ctx({ proposals: [reply] })).status, 'you');
  const otherPr = proposal({ ref: 'pr:70:merge' });
  assert.notEqual(prAttentionStatus(mergeReadyPr(), ctx({ proposals: [otherPr] })).status, 'you');
});

test('an agent parked waiting on a human is your court, not the harness’s', () => {
  const verdict = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ tasks: [task({ status: 'waiting' })] }));
  assert.deepEqual(verdict, { status: 'you', reasons: ['an agent on this branch is waiting on you'] });
});

test('a concern whose attempt cap is spent is handed back to you', () => {
  const spent = [attempt('pr:7:ci', ago(60)), attempt('pr:7:ci', ago(45)), attempt('pr:7:ci', ago(30))];
  const verdict = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ recentDecisions: spent }));
  assert.equal(verdict.status, 'you');
  assert.match(verdict.reasons[0]!, /CI is failing — the attempt cap is spent, escalated to a human/);
});

test('a failure the CI policy holds is your court, not a promise of an agent', () => {
  const held = pr({
    ciStatus: 'failing',
    ciChecks: [
      { name: 'check', status: 'passing' },
      { name: 'codeql', status: 'failing' },
    ],
  });
  const policy = { checks: [{ match: 'codeql*', onFailure: 'escalate' as const }] };
  const verdict = prAttentionStatus(held, ctx({ ci: policy }));
  assert.equal(verdict.status, 'you');
  assert.match(verdict.reasons[0]!, /codeql failing — the CI policy holds it, so no agent will be sent/);
  assert.equal(prAttentionStatus(held, ctx()).status, 'harness');
});

test('a red check the policy dispatches for stays the harness’s', () => {
  const actionable = pr({
    ciStatus: 'failing',
    ciChecks: [{ name: 'check', status: 'failing' }],
  });
  const policy = { checks: [{ match: 'check', onFailure: 'dispatch' as const }] };
  const verdict = prAttentionStatus(actionable, ctx({ ci: policy }));
  assert.deepEqual(verdict, { status: 'harness', reasons: ['CI is failing — an agent will be dispatched'] });
});

test('a failure that is only muted is stalled, and says the merge gate still reads it', () => {
  const muted = mergeReadyPr({
    ciStatus: 'failing',
    ciChecks: [{ name: 'pages', status: 'failing' }],
  });
  const verdict = prAttentionStatus(muted, ctx({ ci: { checks: [{ match: 'pages', onFailure: 'ignore' }] } }));
  assert.equal(verdict.status, 'stalled');
  assert.match(verdict.reasons[0]!, /pages failing but muted by policy/);
  assert.match(verdict.reasons[0]!, /the merge gate still reads CI as failing/);
  assert.ok(
    !verdict.reasons.some((r) => r.includes('CI has not reported')),
    'the muted reading replaces the wording that hid this gap, not sits beside it',
  );
});

test('an inherited failure is never handed to you, whatever the policy says', () => {
  const base = pr({ id: 'p1', number: 1, branch: 'part/one', ciStatus: 'failing' });
  const stacked = pr({ id: 'p2', number: 2, branch: 'part/two', baseBranch: 'part/one', ciStatus: 'failing' });
  const verdict = prAttentionStatus(
    stacked,
    ctx({ openPrs: [base, stacked], ci: { checks: [{ match: '*', onFailure: 'escalate' }] } }),
  );
  assert.equal(verdict.status, 'elsewhere');
  assert.equal(verdict.reasons[0], 'CI failing on base PR #1');
});

test('an agent on the branch is the harness’s court, whatever the PR looks like', () => {
  const verdict = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ tasks: [task()] }));
  assert.deepEqual(verdict, { status: 'harness', reasons: ['an agent is working this branch'] });
  const queued = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ tasks: [task({ status: 'queued' })] }));
  assert.deepEqual(queued, { status: 'harness', reasons: ['an agent is queued for this branch'] });
  const done = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ tasks: [task({ status: 'done' })] }));
  assert.equal(done.reasons[0], 'CI is failing — an agent will be dispatched');
});

test('unstaffed concerns are the harness’s, in rule order, with the rest listed behind', () => {
  const messy = pr({
    ciStatus: 'failing',
    mergeableState: 'behind',
    unresolvedComments: [{ id: 'c1', author: 'reviewer', body: 'nit', handled: false }],
  });
  const verdict = prAttentionStatus(messy, ctx());
  assert.equal(verdict.status, 'harness');
  assert.deepEqual(verdict.reasons, [
    'unresolved comment from reviewer — an agent will be dispatched',
    'CI is failing',
    'behind main',
  ]);
});

test('the review concern reads the origin the dispatcher writes, so a spent cap reads as yours', () => {
  const reviewed = pr({ unresolvedComments: [{ id: 'c1', author: 'nina', body: 'nit', handled: false }] });
  const capped = prAttentionStatus(
    reviewed,
    ctx({
      recentDecisions: [
        attempt('pr:7:comments', ago(90)),
        attempt('pr:7:comments', ago(60)),
        attempt('pr:7:comments', ago(30)),
      ],
    }),
  );
  assert.deepEqual(capped, {
    status: 'you',
    reasons: ['unresolved comment from nina — the attempt cap is spent, escalated to a human'],
  });
  const cooling = prAttentionStatus(reviewed, ctx({ recentDecisions: [attempt('pr:7:comments', ago(2))] }));
  assert.deepEqual(cooling, { status: 'harness', reasons: ['unresolved comment from nina — on cooldown, retrying'] });
});

test('every open thread is one concern, because one agent answers the whole review', () => {
  const reviewed = pr({
    unresolvedComments: [
      { id: 'c1', author: 'nina', body: 'nit', handled: false },
      { id: 'c2', author: 'nina', body: 'again', handled: false },
      { id: 'c3', author: 'omar', body: 'and this', handled: false },
      { id: 'c4', author: 'omar', body: 'done with', handled: true },
    ],
  });
  assert.deepEqual(prAttentionStatus(reviewed, ctx()), {
    status: 'harness',
    reasons: ['3 unresolved comments from nina, omar — an agent will be dispatched'],
  });
});

test('a held check denies an agent only when there is no other concern to staff', () => {
  const policy = { checks: [{ match: 'infra', onFailure: 'escalate' as const }] };
  const held = ctx({ ci: policy });
  const conflicted = pr({
    ciStatus: 'failing',
    ciChecks: [{ name: 'infra', status: 'failing' }],
    mergeableState: 'dirty',
  });
  assert.deepEqual(prAttentionStatus(conflicted, held), {
    status: 'harness',
    reasons: ['conflicts with main — an agent will be dispatched', 'infra failing — held by the CI policy'],
  });
  const alone = pr({ ciStatus: 'failing', ciChecks: [{ name: 'infra', status: 'failing' }] });
  assert.deepEqual(prAttentionStatus(alone, held), {
    status: 'you',
    reasons: ['infra failing — the CI policy holds it, so no agent will be sent'],
  });
});

test('a concern attempted inside the cooldown says so rather than promising an agent', () => {
  const verdict = prAttentionStatus(
    pr({ ciStatus: 'failing' }),
    ctx({ recentDecisions: [attempt('pr:7:ci', ago(2))] }),
  );
  assert.deepEqual(verdict, { status: 'harness', reasons: ['CI is failing — on cooldown, retrying'] });
});

test('a merge-ready PR with no verdict standing is waiting on the merge gate', () => {
  assert.deepEqual(prAttentionStatus(mergeReadyPr(), ctx()), {
    status: 'harness',
    reasons: ['merge-ready — the merge gate runs next cycle'],
  });
});

test('an accepted merge holds as the harness’s while the world catches up', () => {
  const accepted = proposal({ status: 'accepted', decidedBy: 'auto_send', decidedAt: ago(2) });
  const verdict = prAttentionStatus(mergeReadyPr(), ctx({ proposals: [accepted] }));
  assert.equal(verdict.status, 'harness');
  assert.match(verdict.reasons[0]!, /already authorized by auto-send/);
  const stale = proposal({ status: 'accepted', decidedBy: 'auto_send', decidedAt: ago(30) });
  assert.match(
    prAttentionStatus(mergeReadyPr(), ctx({ proposals: [stale] })).reasons[0]!,
    /merge gate runs next cycle/,
  );
});

test('a standing rejection is nobody’s turn, and it quotes what you said', () => {
  const rejected = proposal({
    status: 'rejected',
    decidedBy: 'human',
    decidedAt: ago(60),
    note: 'wait for the release branch',
  });
  const verdict = prAttentionStatus(mergeReadyPr(), ctx({ proposals: [rejected] }));
  assert.equal(verdict.status, 'settled');
  assert.match(verdict.reasons[0]!, /you rejected it — "wait for the release branch"/);
  assert.equal(verdict.reasons[1], 'nothing has happened to this PR since');
});

test('a rejection the world has overtaken stops reading as settled', () => {
  const rejected = proposal({ status: 'rejected', decidedBy: 'human', decidedAt: ago(60), note: 'not yet' });
  const signal: WorldEvent = {
    id: 'we1',
    kind: 'pr_ci',
    ref: 'pr:7',
    summary: 'PR #7 CI passing',
    createdAt: ago(5),
  };
  const verdict = prAttentionStatus(mergeReadyPr(), ctx({ proposals: [rejected], rejectionSignals: [signal] }));
  assert.deepEqual(verdict, { status: 'harness', reasons: ['merge-ready — the merge gate runs next cycle'] });
  const old: WorldEvent = { ...signal, id: 'we0', createdAt: ago(90) };
  assert.equal(
    prAttentionStatus(mergeReadyPr(), ctx({ proposals: [rejected], rejectionSignals: [old] })).status,
    'settled',
  );
});

test('a rejection only reads as settled while the merge gate is the thing it holds', () => {
  const rejected = proposal({ status: 'rejected', decidedBy: 'human', decidedAt: ago(60), note: 'not yet' });
  const verdict = prAttentionStatus(mergeReadyPr({ ciStatus: 'failing' }), ctx({ proposals: [rejected] }));
  assert.equal(verdict.status, 'harness');
});

test('a stacked PR is waiting on the one underneath it', () => {
  const base = pr({ id: 'p6', number: 6, branch: 'feat/base', ciStatus: 'passing' });
  const child = mergeReadyPr({ id: 'p7', number: 7, branch: 'feat/widget', baseBranch: 'feat/base' });
  const verdict = prAttentionStatus(child, ctx({ openPrs: [base, child] }));
  assert.deepEqual(verdict, { status: 'elsewhere', reasons: ['stacked on PR #6, which has to merge first'] });
  const orphan = prAttentionStatus(child, ctx({ openPrs: [child] }));
  assert.deepEqual(orphan, { status: 'elsewhere', reasons: ['stacked on feat/base'] });
});

test('an inherited CI failure names the ancestor and is never the child’s concern', () => {
  const base = pr({ id: 'p6', number: 6, branch: 'feat/base', ciStatus: 'failing' });
  const child = pr({
    number: 7,
    branch: 'feat/widget',
    baseBranch: 'feat/base',
    ciStatus: 'failing',
    approved: true,
    mergeable: true,
  });
  const verdict = prAttentionStatus(child, ctx({ openPrs: [base, child] }));
  assert.deepEqual(verdict, { status: 'elsewhere', reasons: ['CI failing on base PR #6'] });
  const ignoredBase = { ...base, labels: ['lubbdubb-ignore'] };
  assert.equal(prAttentionStatus(child, ctx({ openPrs: [ignoredBase, child] })).reasons[0], 'CI failing on base PR #6');
});

test('CI running, an absent approval and a blocked merge are all outside the loop', () => {
  assert.deepEqual(prAttentionStatus(mergeReadyPr({ ciStatus: 'pending' }), ctx()), {
    status: 'elsewhere',
    reasons: ['CI is still running'],
  });
  assert.deepEqual(prAttentionStatus(pr({ mergeable: true }), ctx()), {
    status: 'elsewhere',
    reasons: ['waiting on review'],
  });
  assert.deepEqual(prAttentionStatus(mergeReadyPr({ mergeableState: 'blocked' }), ctx()), {
    status: 'elsewhere',
    reasons: ['merge blocked (required checks/reviews)'],
  });
});

test('a green, approved PR no rule will ever act on is stalled, and says what is missing', () => {
  const verdict = prAttentionStatus(pr({ approved: true }), ctx());
  assert.deepEqual(verdict, { status: 'stalled', reasons: ['the provider reports no mergeable state'] });
  const noCi = prAttentionStatus(
    pr({ ciStatus: 'unknown', approved: true, mergeable: true, mergeableState: 'clean' }),
    ctx(),
  );
  assert.deepEqual(noCi, { status: 'stalled', reasons: ['CI has not reported'] });
});

test('a comment’s author decides nothing — `handled` does', () => {
  const from = (author: string, handled: boolean): PullRequest =>
    mergeReadyPr({ unresolvedComments: [{ id: 'c1', author, body: 'nit', handled }] });
  const anonymised = (p: PullRequest) => {
    const v = prAttentionStatus(p, ctx());
    return { status: v.status, reasons: v.reasons.map((r) => r.replace(/comment from \S+/, 'comment from <author>')) };
  };
  assert.deepEqual(anonymised(from('reviewer', false)), anonymised(from('someone-else', false)));
  assert.equal(prAttentionStatus(from('reviewer', false), ctx()).status, 'harness');
  assert.equal(prAttentionStatus(from('reviewer', true), ctx()).status, 'harness');
  assert.match(prAttentionStatus(from('reviewer', true), ctx()).reasons[0]!, /merge gate/);
});

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

test('/api/state ships an attention verdict per PR, beside health rather than instead of it', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  system.connector.inject({
    kind: 'new_pr',
    number: 11,
    title: 'Add the widget',
    branch: 'feat/widget',
    labels: ['lubbdubb-watch'],
  });
  system.connector.inject({ kind: 'ci_failed', prNumber: 11 });
  system.store.world.setWorldBaseline(await system.connector.getState());

  const snapshot = await buildStateSnapshot(system);
  const shipped = snapshot.world.pullRequests.find((p) => p.number === 11)!;
  assert.deepEqual(shipped.health.reasons, ['CI failing']);
  assert.equal(shipped.attention.status, 'harness');
  assert.match(shipped.attention.reasons[0]!, /CI is failing/);
  system.store.close();
});

test('a pending proposal and a standing rejection read differently through the whole seam', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  system.connector.inject({
    kind: 'new_pr',
    number: 12,
    title: 'Add the widget',
    branch: 'feat/widget',
    labels: ['lubbdubb-watch'],
  });
  system.connector.inject({ kind: 'ci_passed', prNumber: 12 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 12 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 12, mergeable: true, mergeableState: 'clean' });

  await system.harness.runCycle('manual');
  const [pending] = system.store.escalations.listProposals();
  assert.equal(pending!.status, 'pending');
  const asked = await buildStateSnapshot(system);
  assert.equal(asked.world.pullRequests.find((p) => p.number === 12)!.attention.status, 'you');

  system.proposals.reject(pending!.id, 'wait for the release branch');
  const refused = await buildStateSnapshot(system);
  const verdict = refused.world.pullRequests.find((p) => p.number === 12)!.attention;
  assert.equal(verdict.status, 'settled');
  assert.match(verdict.reasons[0]!, /wait for the release branch/);
  system.store.close();
});

test('the verdict is a lens: nothing in the dispatcher reads it, and computing it decides nothing', async () => {
  const importers = srcFiles('src')
    .filter((f) => f !== 'src/prAttention.ts')
    .filter((f) => readFileSync(f, 'utf8').includes('prAttention.js'));
  assert.deepEqual(
    importers,
    ['src/server/stateSnapshot.ts', 'src/wire.ts'],
    'the attention verdict must stay cockpit-only',
  );

  const world = (system: ReturnType<typeof buildSystem>): void => {
    const watched = ['lubbdubb-watch'];
    system.connector.inject({ kind: 'new_pr', number: 21, title: 'Widget', branch: 'feat/widget', labels: watched });
    system.connector.inject({ kind: 'new_pr', number: 22, title: 'Gadget', branch: 'feat/gadget', labels: watched });
    system.connector.inject({ kind: 'ci_passed', prNumber: 22 });
    system.connector.inject({ kind: 'pr_approved', prNumber: 22 });
    system.connector.inject({ kind: 'pr_mergeable', prNumber: 22, mergeable: true, mergeableState: 'clean' });
  };
  const plan = (system: ReturnType<typeof buildSystem>): string[] =>
    system.store.decisions
      .listDecisions(100)
      .map((d) => `${d.action.type}:${d.outcome}`)
      .sort();

  const control = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const observed = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  world(control);
  world(observed);
  await control.harness.runCycle('manual');
  await observed.harness.runCycle('manual');
  const snapshot = await buildStateSnapshot(observed);
  const statuses = snapshot.world.pullRequests.map((p) => p.attention.status);
  assert.equal(new Set(statuses).size, 2, statuses.join(','));
  await control.harness.runCycle('timer');
  await observed.harness.runCycle('timer');
  assert.deepEqual(plan(observed), plan(control));
  control.store.close();
  observed.store.close();
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

test('awaitingReview runs only while a reviewer could actually act', () => {
  assert.equal(awaitingReview(pr({ approved: false }), false), true);

  assert.equal(awaitingReview(pr({ approved: false }), true), false, 'an agent holds the branch');
  assert.equal(awaitingReview(pr({ approved: false, ciStatus: 'failing' }), false), false, 'red CI');
  assert.equal(
    awaitingReview(
      pr({ approved: false, unresolvedComments: [{ id: 'c', author: 'bob', body: 'no', handled: false }] }),
      false,
    ),
    false,
    'an unhandled comment',
  );
  assert.equal(awaitingReview(pr({ approved: true }), false), false, 'already approved');
  assert.equal(awaitingReview(pr({ approved: false, merged: true }), false), false, 'not open');
});

test('a handled comment does not hold the clock', () => {
  const handled = pr({ approved: false, unresolvedComments: [{ id: 'c', author: 'bob', body: 'ok', handled: true }] });
  assert.equal(awaitingReview(handled, false), true);
});

test('the waiting-on-review arm carries the wait, and stays elsewhere', () => {
  const since = ago(60 * 24 * 3);
  const verdict = prAttentionStatus(pr({ approved: false }), {
    ...ctx(),
    reviewWaits: new Map([[7, since]]),
  });
  assert.equal(verdict.status, 'elsewhere');
  assert.deepEqual(verdict.reasons, ['waiting on review']);
  assert.equal(verdict.reviewWaitingSince, since);
});

test('no wait recorded costs the age and never the verdict', () => {
  const withMap = prAttentionStatus(pr({ approved: false }), { ...ctx(), reviewWaits: new Map() });
  const without = prAttentionStatus(pr({ approved: false }), ctx());
  assert.equal(withMap.status, without.status);
  assert.deepEqual(withMap.reasons, without.reasons);
  assert.equal(without.reviewWaitingSince, undefined);
});

test('an arm above waiting-on-review never carries a wait', () => {
  const verdict = prAttentionStatus(pr({ approved: false, ciStatus: 'failing' }), {
    ...ctx(),
    reviewWaits: new Map([[7, ago(60 * 24 * 5)]]),
  });
  assert.notEqual(verdict.status, 'elsewhere');
  assert.equal(verdict.reviewWaitingSince, undefined);
});

test('the wait is a watermark: it survives a pulse, and clears when the wait ends', () => {
  let tick = 0;
  const store = new Store(':memory:', () => new Date(Date.parse(NOW) + tick++ * 60_000).toISOString());
  store.reviewWaits.foldReviewWaits([7]);
  const first = store.reviewWaits.reviewWaits().get(7);
  assert.ok(first);
  store.reviewWaits.foldReviewWaits([7]);
  assert.equal(store.reviewWaits.reviewWaits().get(7), first);

  store.reviewWaits.foldReviewWaits([]);
  assert.equal(store.reviewWaits.reviewWaits().get(7), undefined);

  store.reviewWaits.foldReviewWaits([7]);
  assert.notEqual(store.reviewWaits.reviewWaits().get(7), first);
  store.close();
});

test('folding one PR does not disturb another still waiting', () => {
  let tick = 0;
  const store = new Store(':memory:', () => new Date(Date.parse(NOW) + tick++ * 60_000).toISOString());
  store.reviewWaits.foldReviewWaits([7, 8]);
  const seven = store.reviewWaits.reviewWaits().get(7);
  store.reviewWaits.foldReviewWaits([7]);
  assert.equal(store.reviewWaits.reviewWaits().get(7), seven);
  assert.equal(store.reviewWaits.reviewWaits().get(8), undefined);
  store.close();
});

const prOrigin = (a: ValidatedAction): string | null => {
  if ('originRef' in a && typeof a.originRef === 'string' && a.originRef.startsWith('pr:7:')) return a.originRef;
  if (a.type === 'escalate_to_human') {
    const ref = (a.context as { originRef?: unknown } | undefined)?.originRef;
    return typeof ref === 'string' && ref.startsWith('pr:7:') ? ref : null;
  }
  return null;
};

const LABEL_FOR: Record<string, RegExp> = {
  'pr:7:comments': /^unresolved comments? from /,
  'pr:7:ci': /^CI is failing/,
  'pr:7:ci-gate': /waiting on an action/,
  'pr:7:mergeable': /^(behind|conflicts with) main/,
};

const CI_ARMS: { name: string; policy: CiPolicy; over: Partial<PullRequest> }[] = [
  { name: 'green', policy: { checks: [] }, over: {} },
  { name: 'red-actionable', policy: { checks: [] }, over: { ciStatus: 'failing' } },
  {
    name: 'red-escalate',
    policy: { checks: [{ match: 'infra', onFailure: 'escalate' }] },
    over: { ciStatus: 'failing', ciChecks: [{ name: 'infra', status: 'failing' }] },
  },
  {
    name: 'red-muted',
    policy: { checks: [{ match: 'infra', onFailure: 'ignore' }] },
    over: { ciStatus: 'failing', ciChecks: [{ name: 'infra', status: 'failing' }] },
  },
];

test('the lens names the concern the dispatcher acts on, and the court it acts in', async () => {
  const comment = { id: 'c1', author: 'nina', body: 'nit', handled: false };
  let checked = 0;
  for (const arm of CI_ARMS) {
    for (const comments of [[], [comment]]) {
      for (const mergeableState of ['clean', 'behind', 'dirty'] as const) {
        for (const history of [[], ...Object.keys(LABEL_FOR).map((o) => [o])]) {
          const recentDecisions = history.flatMap((o) => [
            attempt(o, ago(90)),
            attempt(o, ago(60)),
            attempt(o, ago(30)),
          ]);
          const subject = pr({ ...arm.over, baseBranch: 'main', mergeableState, unresolvedComments: comments });
          const lens = prAttentionStatus(subject, ctx({ ci: arm.policy, recentDecisions }));
          const dispatcher = new RuleDispatcher({ cooldown: DEFAULT_COOLDOWN, defaultBranch: 'main', ci: arm.policy });
          const result = await dispatcher.decide({
            world: { takenAt: NOW, pullRequests: [subject], issues: [] },
            tasks: [],
            agents: [],
            openEscalations: [],
            queuedJobs: [],
            agentHeadroom: 5,
            recentDecisions,
          });
          const acted = result.actions
            .filter((a) => a.type !== 'escalate_to_human')
            .map(prOrigin)
            .filter(Boolean);
          const escalated = result.actions
            .filter((a) => a.type === 'escalate_to_human')
            .map(prOrigin)
            .filter(Boolean);
          const where = `${arm.name} comments=${comments.length} ${mergeableState} hist=${history[0] ?? 'fresh'}`;
          if (acted.length > 0) {
            assert.equal(lens.status, 'harness', where);
            assert.match(lens.reasons[0]!, /an agent will be dispatched$/, where);
            assert.match(lens.reasons[0]!, LABEL_FOR[acted[0]!]!, where);
          } else if (escalated.length > 0) {
            assert.equal(lens.status, 'you', where);
          }
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 4 * 2 * 3 * 5);
});
