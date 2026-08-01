import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ciFailureNote,
  ciNeedsHuman,
  classifyCiFailures,
  matchesCheckGlob,
  validateCiPolicy,
  type CiPolicy,
} from '../src/ci/ciPolicy.js';
import { loadConfig } from '../src/config.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { prHealth } from '../src/prHealth.js';
import { aggregateCiStatus, listCiChecks } from '../src/integrations/github/sourceControl.js';
import { aggregatePolicyCiStatus, listPolicyCiChecks } from '../src/integrations/azure/sourceControl.js';
import type { AzPolicyEvaluation } from '../src/integrations/azure/azureDevOpsApi.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { CiCheck, Decision, Escalation, PullRequest, WorldSnapshot } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR ${number}`,
    branch: `feature/${number}`,
    baseBranch: 'main',
    ciStatus: 'failing',
    unresolvedComments: [],
    ...over,
  };
}

function world(pullRequests: PullRequest[]): WorldSnapshot {
  return { takenAt: '2026-07-28T12:00:00.000Z', pullRequests, issues: [] };
}

function context(pullRequests: PullRequest[], extra: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: world(pullRequests),
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    steeringPriorities: [],
    agentHeadroom: 5,
    recentDecisions: [],
    ...extra,
  };
}

function checks(...pairs: Array<[string, CiCheck['status']]>): CiCheck[] {
  return pairs.map(([name, status]) => ({ name, status }));
}

const policy = (...rules: CiPolicy['checks']): CiPolicy => ({ checks: rules });

// --------------------------------------------------------------------------
// Glob matching
// --------------------------------------------------------------------------

test('matchesCheckGlob: * spans, ? is one, everything else is literal', () => {
  assert.equal(matchesCheckGlob('lint', 'lint'), true);
  assert.equal(matchesCheckGlob('lint', 'lint-ts'), false);
  assert.equal(matchesCheckGlob('test (*)', 'test (18)'), true);
  assert.equal(matchesCheckGlob('test (*)', 'test (20, ubuntu)'), true);
  assert.equal(matchesCheckGlob('test (*)', 'build'), false);
  assert.equal(matchesCheckGlob('node-??', 'node-18'), true);
  assert.equal(matchesCheckGlob('node-??', 'node-8'), false);
  // Regex metacharacters in a name are literals, not a pattern the operator
  // has to escape — check names are full of dots and brackets.
  assert.equal(matchesCheckGlob('build.prod', 'build.prod'), true);
  assert.equal(matchesCheckGlob('build.prod', 'buildXprod'), false);
});

test('matchesCheckGlob: case-insensitive, because a check name is a label someone typed elsewhere', () => {
  assert.equal(matchesCheckGlob('Deploy-Preview', 'deploy-preview'), true);
  assert.equal(matchesCheckGlob('deploy-*', 'Deploy-Staging'), true);
});

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

test('classifyCiFailures: no per-check detail is actionable — the pre-policy behaviour', () => {
  const withNothing = classifyCiFailures(undefined, policy({ match: 'lint', onFailure: 'ignore' }));
  assert.equal(withNothing.actionable, true);
  assert.deepEqual(withNothing.dispatch, []);
  assert.deepEqual(withNothing.ignored, []);

  // An empty list is the same silence: the provider named nothing.
  assert.equal(classifyCiFailures([], policy({ match: '*', onFailure: 'ignore' })).actionable, true);
});

test('classifyCiFailures: an unmatched failing check is actionable and named', () => {
  const v = classifyCiFailures(
    checks(['brand-new-check', 'failing']),
    policy({ match: 'lint', onFailure: 'dispatch' }),
  );
  assert.equal(v.actionable, true);
  assert.deepEqual(
    v.dispatch.map((m) => m.name),
    ['brand-new-check'],
  );
  assert.equal(v.dispatch[0]!.rule, null);
});

test('classifyCiFailures: onFailure defaults to ignore, so naming a check is enough to stop acting on it', () => {
  const v = classifyCiFailures(checks(['deploy-preview', 'failing']), policy({ match: 'deploy-*' }));
  assert.equal(v.actionable, false);
  assert.deepEqual(
    v.ignored.map((m) => m.name),
    ['deploy-preview'],
  );
});

test('classifyCiFailures: only failing checks are classified', () => {
  const v = classifyCiFailures(
    checks(['lint', 'passing'], ['build', 'failing'], ['e2e', 'pending']),
    policy({ match: '*', onFailure: 'dispatch' }),
  );
  assert.deepEqual(
    v.dispatch.map((m) => m.name),
    ['build'],
  );
});

test('classifyCiFailures: first matching rule wins', () => {
  const v = classifyCiFailures(
    checks(['deploy-preview', 'failing']),
    policy({ match: 'deploy-preview', onFailure: 'dispatch' }, { match: 'deploy-*', onFailure: 'ignore' }),
  );
  assert.equal(v.actionable, true);
});

test('classifyCiFailures: one actionable check among held ones dispatches for the branch', () => {
  const v = classifyCiFailures(
    checks(['lint', 'failing'], ['deploy-preview', 'failing'], ['infra-gate', 'failing']),
    policy(
      { match: 'lint', onFailure: 'dispatch', guidance: 'Run the lint skill.' },
      { match: 'deploy-*', onFailure: 'ignore' },
      { match: 'infra-*', onFailure: 'escalate' },
    ),
  );
  assert.equal(v.actionable, true);
  assert.deepEqual(
    v.dispatch.map((m) => m.name),
    ['lint'],
  );
  // Escalating alongside a dispatch would ask a human to look at a PR an agent
  // is already working. The held checks reach that agent through the note.
  assert.equal(ciNeedsHuman(v), false);
});

test('ciNeedsHuman: only when nothing is dispatchable and a rule asked for a human', () => {
  const escalateOnly = classifyCiFailures(
    checks(['infra-gate', 'failing']),
    policy({ match: 'infra-*', onFailure: 'escalate' }),
  );
  assert.equal(ciNeedsHuman(escalateOnly), true);

  const ignoreOnly = classifyCiFailures(
    checks(['infra-gate', 'failing']),
    policy({ match: 'infra-*', onFailure: 'ignore' }),
  );
  assert.equal(ciNeedsHuman(ignoreOnly), false);
});

test('classifyCiFailures: urgent rides on a dispatched check only', () => {
  const hit = classifyCiFailures(
    checks(['security-scan', 'failing']),
    policy({ match: 'security-*', onFailure: 'dispatch', urgent: true }),
  );
  assert.equal(hit.urgent, true);

  const miss = classifyCiFailures(
    checks(['lint', 'failing']),
    policy({ match: 'security-*', onFailure: 'dispatch', urgent: true }, { match: 'lint', onFailure: 'dispatch' }),
  );
  assert.equal(miss.urgent, false);
});

// --------------------------------------------------------------------------
// The prompt note
// --------------------------------------------------------------------------

test('ciFailureNote: names guidance per check and warns off the held ones', () => {
  const v = classifyCiFailures(
    checks(['lint', 'failing'], ['deploy-preview', 'failing']),
    policy({ match: 'lint', onFailure: 'dispatch', guidance: 'Run the lint skill.' }, { match: 'deploy-*' }),
  );
  const note = ciFailureNote(v);
  assert.match(note, /lint: Run the lint skill\./);
  assert.match(note, /NOT yours to fix — deploy-preview/);
});

test('ciFailureNote: nothing to say adds nothing at all', () => {
  const v = classifyCiFailures(checks(['build', 'failing']), policy());
  assert.equal(ciFailureNote(v), '');
});

// --------------------------------------------------------------------------
// Advisory and non-blocking checks
// --------------------------------------------------------------------------

test('classifyCiFailures: an advisory failing check is never classified', () => {
  // Not dispatched, not escalated, not muted — it is not the CI policy's business
  // at all. Rule `pr-review-comment` owns the signal the Azure comment policy restates.
  const v = classifyCiFailures([{ name: 'Comment requirements', status: 'failing', advisory: true }], policy());
  assert.deepEqual(v.dispatch, []);
  assert.deepEqual(v.escalate, []);
  assert.deepEqual(v.ignored, []);
});

test('classifyCiFailures: no ci.checks rule can claim an advisory check', () => {
  const v = classifyCiFailures(
    [{ name: 'Comment requirements', status: 'failing', advisory: true }],
    policy({ match: '*', onFailure: 'escalate' }),
  );
  assert.deepEqual(v.escalate, []);
  assert.equal(ciNeedsHuman(v), false);
});

test('classifyCiFailures: an Optional failing check dispatches, carrying that it does not block', () => {
  const v = classifyCiFailures(
    [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
    policy(),
  );
  assert.equal(v.actionable, true);
  assert.deepEqual(
    v.dispatch.map((m) => ({ name: m.name, blocking: m.blocking })),
    [{ name: 'Dotnet Code Format Validation', blocking: false }],
  );
});

test('ciFailureNote: a non-blocking failure is named as not holding the merge', () => {
  const v = classifyCiFailures(
    [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
    policy(),
  );
  const note = ciFailureNote(v);
  assert.match(note, /do not block the merge — Dotnet Code Format Validation/);
});

test('ciFailureNote: a blocking failure says nothing about blocking', () => {
  const v = classifyCiFailures([{ name: 'Build-dotnet', status: 'failing', blocking: true }], policy());
  assert.equal(ciFailureNote(v), '');
});

// --------------------------------------------------------------------------
// Config validation — the load-time refusals
// --------------------------------------------------------------------------

test('validateCiPolicy: guidance on a rule that never dispatches is refused, not discarded', () => {
  assert.throws(
    () => validateCiPolicy(policy({ match: 'lint', guidance: 'Run the lint skill.' })),
    /guidance.*discarded/s,
  );
  assert.throws(
    () => validateCiPolicy(policy({ match: 'lint', onFailure: 'escalate', guidance: 'Run it.' })),
    /guidance/,
  );
  // The legal combination passes.
  validateCiPolicy(policy({ match: 'lint', onFailure: 'dispatch', guidance: 'Run it.' }));
});

test('validateCiPolicy: urgent without a dispatch orders a queue nothing is in', () => {
  assert.throws(() => validateCiPolicy(policy({ match: 'lint', urgent: true })), /urgent/);
});

test('validateCiPolicy: a bad match or onFailure fails at load', () => {
  assert.throws(() => validateCiPolicy(policy({ match: '' })), /non-empty glob/);
  assert.throws(
    () => validateCiPolicy(policy({ match: 'lint', onFailure: 'dispatchh' as never })), //
    /not one of/,
  );
});

test('loadConfig: the ci block defaults to empty, round-trips, and is validated at load', () => {
  assert.deepEqual(loadConfig().ci, { checks: [] });

  const rules = [{ match: 'deploy-*', onFailure: 'ignore' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: rules } }).ci.checks, rules);

  // The refusal is at load, not at the first red PR days later.
  assert.throws(() => loadConfig({ ci: { checks: [{ match: 'lint', guidance: 'x' }] } }), /guidance/);
});

// --------------------------------------------------------------------------
// Rule `pr-ci-failing`, through the dispatcher
// --------------------------------------------------------------------------

async function decide(prs: PullRequest[], ci: CiPolicy, extra: Partial<DispatchContext> = {}) {
  const dispatcher = new RuleDispatcher({}, {}, undefined, 'main', {}, {}, ci);
  return dispatcher.decide(context(prs, extra));
}

test('rule `pr-ci-failing`: an unconfigured harness dispatches on any failure, exactly as before', async () => {
  const result = await decide([pr(7, { ciChecks: checks(['lint', 'failing']) })], policy());
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'pr:7:ci');
});

test('rule `pr-ci-failing`: an ignored check leaves the PR alone — no agent, no escalation', async () => {
  const result = await decide(
    [pr(7, { ciChecks: checks(['deploy-preview', 'failing']) })],
    policy({ match: 'deploy-*', onFailure: 'ignore' }),
  );
  assert.equal(
    result.actions.some((a) => a.type === 'dispatch_code_agent' || a.type === 'escalate_to_human'),
    false,
  );
});

test('rule `pr-ci-failing`: guidance reaches the agent appended to the prompt, not interpolated into it', async () => {
  const result = await decide(
    [pr(7, { ciChecks: checks(['lint', 'failing'], ['deploy-preview', 'failing']) })],
    policy({ match: 'lint', onFailure: 'dispatch', guidance: 'Run the lint skill.' }, { match: 'deploy-*' }),
  );
  const dispatch = result.actions.find((a) => a.type === 'dispatch_code_agent');
  assert.ok(dispatch && dispatch.type === 'dispatch_code_agent');
  // The stock template survives ahead of the appended note.
  assert.match(dispatch.prompt, /PR #7/);
  assert.match(dispatch.prompt, /lint: Run the lint skill\./);
  assert.match(dispatch.prompt, /NOT yours to fix — deploy-preview/);
});

test('rule `pr-ci-failing`: an escalate-only failure asks a human once and dispatches nobody', async () => {
  const ci = policy({ match: 'infra-*', onFailure: 'escalate' });
  const prs = [pr(7, { ciChecks: checks(['infra-gate', 'failing']) })];

  const first = await decide(prs, ci);
  const escalations = first.actions.filter((a) => a.type === 'escalate_to_human');
  assert.equal(escalations.length, 1);
  assert.equal(
    first.actions.some((a) => a.type === 'dispatch_code_agent'),
    false,
  );
  assert.match(escalations[0]!.prompt, /infra-gate/);

  // Held by the open item it just created.
  const open = [{ context: { originRef: 'pr:7:ci' } } as Escalation];
  const second = await decide(prs, ci, { openEscalations: open });
  assert.equal(
    second.actions.some((a) => a.type === 'escalate_to_human'),
    false,
  );

  // And by the audit log once that item has been answered but the world has not moved.
  const audited = [
    {
      outcome: 'executed',
      action: { type: 'escalate_to_human', context: { originRef: 'pr:7:ci' } },
      createdAt: '2026-07-28T11:59:00.000Z',
    } as unknown as Decision,
  ];
  const third = await decide(prs, ci, { recentDecisions: audited });
  assert.equal(
    third.actions.some((a) => a.type === 'escalate_to_human'),
    false,
  );
});

test('rule `pr-ci-failing`: an urgent check sorts its PR ahead of other PR concerns', async () => {
  const prs = [
    pr(5, { ciChecks: checks(['lint', 'failing']) }),
    pr(9, { ciChecks: checks(['security-scan', 'failing']) }),
  ];
  const result = await decide(
    prs,
    policy({ match: 'security-*', onFailure: 'dispatch', urgent: true }, { match: 'lint', onFailure: 'dispatch' }),
    { agentHeadroom: 1 },
  );
  // Only one slot: the urgent one takes it, despite the lower PR number losing
  // the natural tie-break.
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'pr:9:ci');
  // The other is still visible in the queue rather than silently dropped.
  assert.equal(
    result.upcoming?.some((q) => q.origin === 'pr:5:ci'),
    true,
  );
});

test('rule `pr-ci-failing`: a stacked PR whose base is red is still suppressed, policy or no policy', async () => {
  const base = pr(1, { branch: 'feature/1', ciChecks: checks(['lint', 'failing']) });
  const child = pr(2, { branch: 'feature/2', baseBranch: 'feature/1', ciChecks: checks(['lint', 'failing']) });
  const result = await decide([base, child], policy({ match: 'lint', onFailure: 'dispatch' }));
  const origins = result.actions.filter((a) => a.type === 'dispatch_code_agent').map((a) => a.originRef);
  assert.deepEqual(origins, ['pr:1:ci']);
});

// --------------------------------------------------------------------------
// Surfacing
// --------------------------------------------------------------------------

test('prHealth: names the failing checks, and caps a matrix so the row stays readable', () => {
  assert.deepEqual(prHealth(pr(7, { ciChecks: checks(['lint', 'failing'], ['build', 'passing']) })).reasons, [
    'CI failing: lint',
  ]);
  // No detail => the long-standing wording, unchanged.
  assert.deepEqual(prHealth(pr(7)).reasons, ['CI failing']);

  const many = checks(...(['a', 'b', 'c', 'd', 'e'].map((n) => [n, 'failing']) as Array<[string, CiCheck['status']]>));
  assert.deepEqual(prHealth(pr(7, { ciChecks: many })).reasons, ['CI failing: a, b, c +2 more']);
});

// --------------------------------------------------------------------------
// Providers: the check list and the fold agree, because they read one input
// --------------------------------------------------------------------------

test('listCiChecks: github check-runs and commit statuses, named and folded consistently', () => {
  const runs = [
    { name: 'lint', status: 'completed', conclusion: 'failure' },
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'in_progress', conclusion: null },
  ];
  const status = { state: 'failure', totalCount: 1, statuses: [{ context: 'deploy/preview', state: 'failure' }] };

  assert.deepEqual(listCiChecks(runs, status), [
    { name: 'lint', status: 'failing' },
    { name: 'build', status: 'passing' },
    { name: 'e2e', status: 'pending' },
    { name: 'deploy/preview', status: 'failing' },
  ]);
  // The two readings of one input never disagree about whether the PR is red.
  assert.equal(aggregateCiStatus(runs, status), 'failing');
});

test('listPolicyCiChecks: azure surfaces every enabled CI policy, Optional ones included', () => {
  const BUILD = '0609b952-1397-4640-95ec-e00a01b2c241';
  const REVIEWERS = 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd';
  const evals: AzPolicyEvaluation[] = [
    {
      typeId: BUILD,
      typeName: 'Build',
      displayName: 'CI build',
      status: 'rejected',
      isBlocking: true,
      isEnabled: true,
    },
    {
      typeId: BUILD,
      typeName: 'Build',
      displayName: 'optional build',
      status: 'rejected',
      isBlocking: false,
      isEnabled: true,
    },
    {
      typeId: REVIEWERS,
      typeName: 'Minimum number of reviewers',
      displayName: 'two reviewers',
      status: 'rejected',
      isBlocking: true,
      isEnabled: true,
    },
    {
      typeId: BUILD,
      typeName: 'Build',
      displayName: 'stale build',
      status: 'rejected',
      isBlocking: true,
      isEnabled: false,
    },
  ];

  // An Optional policy is a real failing check the harness can fix, so it is
  // listed — with `blocking: false`, which is the only thing that stops it being
  // mistaken for a reason the PR cannot merge. A reviewers policy is a human gate
  // and a disabled one is stale noise; neither is CI.
  assert.deepEqual(listPolicyCiChecks(evals), [
    { name: 'CI build', status: 'failing', blocking: true },
    { name: 'optional build', status: 'failing', blocking: false },
  ]);
  // The fold is frozen on the required checks: `ciStatus` is the merge question.
  assert.equal(aggregatePolicyCiStatus(evals), 'failing');
  assert.equal(aggregatePolicyCiStatus([evals[1]!]), 'unknown');
});

// --------------------------------------------------------------------------
// The cockpit's half (issue #168)
// --------------------------------------------------------------------------

test('/api/state ships the classification verdict, from the same call the dispatcher makes', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildSystem } = await import('../src/system.js');
  const { FakePtyBackend } = await import('../src/pty/fakeBackend.js');
  const { buildStateSnapshot } = await import('../src/server/app.js');

  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-ci-'));
  const ci: CiPolicy = {
    checks: [
      { match: 'flaky*', onFailure: 'ignore' },
      { match: 'deploy/*', onFailure: 'escalate' },
    ],
  };
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      dispatcher: 'rule',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      ci,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );

  // The baseline is seeded rather than pulsed: the verdict under test is the one
  // the cockpit reads, and a cycle would put an agent on the red CI as well.
  const checks: CiCheck[] = [
    { name: 'unit', status: 'failing' },
    { name: 'deploy/preview', status: 'failing' },
    { name: 'flaky-suite', status: 'failing' },
  ];
  const world = await system.connector.getState();
  system.store.setWorldBaseline({
    ...world,
    pullRequests: [pr(31, { ciStatus: 'failing', ciChecks: checks })],
  });

  const snapshot = buildStateSnapshot(system) as unknown as {
    world: { pullRequests: { number: number; ciVerdict: unknown }[] };
  };
  const shipped = snapshot.world.pullRequests.find((p) => p.number === 31)!.ciVerdict;
  // Asserted against the function itself rather than against a transcribed
  // literal: a second expectation written out by hand is a second implementation
  // of the classifier, and the whole reason this is computed server-side is that
  // two answers to this question drift silently — the floor saying *repair* while
  // the harness held.
  assert.deepEqual(shipped, classifyCiFailures(checks, ci));
  system.store.close?.();
});
