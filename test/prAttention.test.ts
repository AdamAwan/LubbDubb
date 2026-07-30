import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prAttentionStatus, type PrAttentionContext } from '../src/prAttention.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildStateSnapshot } from '../src/server/app.js';
import type { Decision, Proposal, PullRequest, Task, WorldEvent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

const NOW = '2026-07-26T12:00:00.000Z';
/** `mins` minutes before {@link NOW}, for cooldown and settle-window arithmetic. */
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

/** A PR rule 3 would merge: green, approved, mergeable, nothing outstanding. */
function mergeReadyPr(over: Partial<PullRequest> = {}): PullRequest {
  return pr({ approved: true, mergeable: true, mergeableState: 'clean', ...over });
}

function ctx(over: Partial<PrAttentionContext> = {}): PrAttentionContext {
  return {
    openPrs: [],
    defaultBranch: 'main',
    ignoreLabel: 'lubbdubb-ignore',
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

/** An executed dispatch on `origin`, which is what `dispatchVerdict` counts as an attempt. */
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

// --- done / ignored: the two arms that are nobody's turn by construction -----

test('a merged or abandoned PR is off the board', () => {
  assert.deepEqual(prAttentionStatus(pr({ merged: true }), ctx()), { status: 'done', reasons: ['merged'] });
  assert.deepEqual(prAttentionStatus(pr({ state: 'closed' }), ctx()), {
    status: 'done',
    reasons: ['closed without merging'],
  });
});

test('an -ignore tagged PR is a status of its own, and it wins over every signal', () => {
  // Failing CI *and* an unresolved comment: without the tag this is the harness's
  // court. `Harness.runCycle` filters it out of the dispatch world, so saying so
  // would be describing rules that cannot fire.
  const tagged = pr({
    labels: ['lubbdubb-ignore'],
    ciStatus: 'failing',
    unresolvedComments: [{ id: 'c1', author: 'reviewer', body: 'hm', handled: false }],
  });
  const verdict = prAttentionStatus(tagged, ctx());
  assert.equal(verdict.status, 'ignored');
  assert.match(verdict.reasons[0]!, /lubbdubb-ignore/);
  // Gate off (empty label) => nothing is ignored, same as `isPrExcluded`.
  assert.notEqual(prAttentionStatus(tagged, ctx({ ignoreLabel: '' })).status, 'ignored');
});

// --- your court -------------------------------------------------------------

test('a pending proposal is named on the PR row, not deferred to the inbox', () => {
  const verdict = prAttentionStatus(mergeReadyPr(), ctx({ proposals: [proposal()] }));
  assert.equal(verdict.status, 'you');
  assert.match(verdict.reasons[0]!, /awaiting your accept\/reject of the merge \(prop_1\)/);
});

test('a pending reply draft counts too, and a proposal on another PR does not', () => {
  const reply = proposal({ id: 'prop_2', kind: 'reply_draft', ref: 'pr:7:comment:c1' });
  assert.equal(prAttentionStatus(mergeReadyPr(), ctx({ proposals: [reply] })).status, 'you');
  // `pr:70:merge` must not match PR #7 — the ref prefix carries its own colon.
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
  // The whole point of a per-check policy: `codeql` is red, the operator has said a
  // human owns it, so rule 1 does not dispatch and rule `pr-ci-blocked` escalates.
  // Reading the aggregate `ciStatus` alone reported "an agent will be dispatched",
  // which is a promise the dispatcher does not keep.
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
  // With no policy the same PR is the harness's, unchanged — the classification
  // falls back to "no detail, act generically", which is the pre-policy behaviour.
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
  // Nothing dispatches and nothing escalates — but rule 3's merge test reads the
  // *aggregate*, which is still failing, so this PR can never move. The old wording
  // was "CI has not reported", which is untrue of a check that reported and was muted.
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
  // The fix belongs to the PR underneath. `ciReading` excludes an inherited failure
  // for the same reason rule 1 suppresses the concern, so a policy that would
  // otherwise escalate cannot make a stacked PR your problem.
  const base = pr({ id: 'p1', number: 1, branch: 'part/one', ciStatus: 'failing' });
  const stacked = pr({ id: 'p2', number: 2, branch: 'part/two', baseBranch: 'part/one', ciStatus: 'failing' });
  const verdict = prAttentionStatus(
    stacked,
    ctx({ openPrs: [base, stacked], ci: { checks: [{ match: '*', onFailure: 'escalate' }] } }),
  );
  assert.equal(verdict.status, 'elsewhere');
  assert.equal(verdict.reasons[0], 'CI failing on base PR #1');
});

// --- the harness's court ----------------------------------------------------

test('an agent on the branch is the harness’s court, whatever the PR looks like', () => {
  const verdict = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ tasks: [task()] }));
  assert.deepEqual(verdict, { status: 'harness', reasons: ['an agent is working this branch'] });
  const queued = prAttentionStatus(pr({ ciStatus: 'failing' }), ctx({ tasks: [task({ status: 'queued' })] }));
  assert.deepEqual(queued, { status: 'harness', reasons: ['an agent is queued for this branch'] });
  // A finished task no longer staffs the branch.
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
    'CI is failing — an agent will be dispatched',
    'behind main',
    'unresolved comment from reviewer',
  ]);
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
  // Past the settle window the hold is gone and the gate runs again.
  const stale = proposal({ status: 'accepted', decidedBy: 'auto_send', decidedAt: ago(30) });
  assert.match(
    prAttentionStatus(mergeReadyPr(), ctx({ proposals: [stale] })).reasons[0]!,
    /merge gate runs next cycle/,
  );
});

// --- settled: you answered, and the world has not moved ---------------------

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
  // A signal predating the verdict changes nothing — it is not news.
  const old: WorldEvent = { ...signal, id: 'we0', createdAt: ago(90) };
  assert.equal(
    prAttentionStatus(mergeReadyPr(), ctx({ proposals: [rejected], rejectionSignals: [old] })).status,
    'settled',
  );
});

test('a rejection only reads as settled while the merge gate is the thing it holds', () => {
  // The PR went red after the refusal: rule 1 dispatches regardless of a merge
  // verdict, so the honest answer is the harness's court, not "settled".
  const rejected = proposal({ status: 'rejected', decidedBy: 'human', decidedAt: ago(60), note: 'not yet' });
  const verdict = prAttentionStatus(mergeReadyPr({ ciStatus: 'failing' }), ctx({ proposals: [rejected] }));
  assert.equal(verdict.status, 'harness');
});

// --- elsewhere --------------------------------------------------------------

test('a stacked PR is waiting on the one underneath it', () => {
  const base = pr({ id: 'p6', number: 6, branch: 'feat/base', ciStatus: 'passing' });
  const child = mergeReadyPr({ id: 'p7', number: 7, branch: 'feat/widget', baseBranch: 'feat/base' });
  const verdict = prAttentionStatus(child, ctx({ openPrs: [base, child] }));
  assert.deepEqual(verdict, { status: 'elsewhere', reasons: ['stacked on PR #6, which has to merge first'] });
  // No PR under it in the world — name the branch rather than inventing a number.
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
  // The base is found off the *unfiltered* list, so an `-ignore`d parent still attributes.
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

// --- stalled ----------------------------------------------------------------

test('a green, approved PR no rule will ever act on is stalled, and says what is missing', () => {
  // Nothing to fix, nobody asked, and rule 3 will not fire because the provider
  // never reported mergeability. This is the case the verdict exists to surface.
  const verdict = prAttentionStatus(pr({ approved: true }), ctx());
  assert.deepEqual(verdict, { status: 'stalled', reasons: ['the provider reports no mergeable state'] });
  const noCi = prAttentionStatus(
    pr({ ciStatus: 'unknown', approved: true, mergeable: true, mergeableState: 'clean' }),
    ctx(),
  );
  assert.deepEqual(noCi, { status: 'stalled', reasons: ['CI has not reported'] });
});

// --- what the verdict deliberately does not read ----------------------------

test('a comment’s author decides nothing — `handled` does', () => {
  const from = (author: string, handled: boolean): PullRequest =>
    mergeReadyPr({ unresolvedComments: [{ id: 'c1', author, body: 'nit', handled }] });
  // Two different authors, one verdict once the name is taken out of the wording:
  // the author is what a reason *says*, never what the verdict branches on.
  const anonymised = (p: PullRequest) => {
    const v = prAttentionStatus(p, ctx());
    return { status: v.status, reasons: v.reasons.map((r) => r.replace(/comment from \S+/, 'comment from <author>')) };
  };
  assert.deepEqual(anonymised(from('reviewer', false)), anonymised(from('someone-else', false)));
  assert.equal(prAttentionStatus(from('reviewer', false), ctx()).status, 'harness');
  // Handled: no concern, so the merge gate is what is next.
  assert.equal(prAttentionStatus(from('reviewer', true), ctx()).status, 'harness');
  assert.match(prAttentionStatus(from('reviewer', true), ctx()).reasons[0]!, /merge gate/);
});

// --- the plumbing, at the buildSystem seam ----------------------------------

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
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
  system.connector.inject({ kind: 'new_pr', number: 11, title: 'Add the widget', branch: 'feat/widget' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 11 });
  // The snapshot draws the world the *pulse* observed, never a fresh provider
  // read. Seeded rather than pulsed: a cycle would put an agent on the red CI and
  // the attention verdict under test is the one with no agent on the branch.
  system.store.setWorldBaseline(await system.connector.getState());

  const snapshot = await buildStateSnapshot(system);
  const shipped = snapshot.world.pullRequests.find((p) => p.number === 11)!;
  // Two questions, two answers: health says *can this merge*, attention says *whose turn*.
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
  system.connector.inject({ kind: 'new_pr', number: 12, title: 'Add the widget', branch: 'feat/widget' });
  system.connector.inject({ kind: 'ci_passed', prNumber: 12 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 12 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 12, mergeable: true, mergeableState: 'clean' });

  // The default posture (autoSend off) turns rule 3's merge into a pending ask.
  await system.harness.runCycle('manual');
  const [pending] = system.store.listProposals();
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
  // Structural, the way the findings tool's "nothing reads this" property is kept:
  // one consumer, and it is the snapshot the cockpit fetches.
  const importers = srcFiles('src')
    .filter((f) => f !== 'src/prAttention.ts')
    .filter((f) => readFileSync(f, 'utf8').includes('prAttention.js'));
  assert.deepEqual(importers, ['src/server/app.ts'], 'the attention verdict must stay cockpit-only');

  // Behavioural: building the snapshot (which computes the verdict for every PR)
  // between two pulses changes no decision the harness goes on to make.
  // Deliberately a world that dispatches no agent: PR 21 is waiting on CI and PR 22
  // is merge-ready, so the pulse's only effect is rule 3's proposal — which is the
  // one the verdict could conceivably influence, and must not.
  const world = (system: ReturnType<typeof buildSystem>): void => {
    system.connector.inject({ kind: 'new_pr', number: 21, title: 'Widget', branch: 'feat/widget' });
    system.connector.inject({ kind: 'new_pr', number: 22, title: 'Gadget', branch: 'feat/gadget' });
    system.connector.inject({ kind: 'ci_passed', prNumber: 22 });
    system.connector.inject({ kind: 'pr_approved', prNumber: 22 });
    system.connector.inject({ kind: 'pr_mergeable', prNumber: 22, mergeable: true, mergeableState: 'clean' });
  };
  const plan = (system: ReturnType<typeof buildSystem>): string[] =>
    system.store
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
  // The verdicts genuinely differ across the two PRs, so this is not a vacuous run.
  const statuses = snapshot.world.pullRequests.map((p) => p.attention.status);
  assert.equal(new Set(statuses).size, 2, statuses.join(','));
  await control.harness.runCycle('timer');
  await observed.harness.runCycle('timer');
  assert.deepEqual(plan(observed), plan(control));
  control.store.close();
  observed.store.close();
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
