import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ciFailureNote,
  ciNeedsHuman,
  ciWatchNote,
  classifyCiFailures,
  classifyWatchedChecks,
  matchesCheckGlob,
  validateCiPolicy,
  type CiPolicy,
} from '../src/ci/ciPolicy.js';
import { describeCiPolicy } from '../src/ci/describeCiPolicy.js';
import { loadConfig } from '../src/config.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { prHealth } from '../src/prHealth.js';
import { aggregateCiStatus, listCiChecks } from '../src/integrations/github/sourceControl.js';
import { aggregatePolicyCiStatus, listPolicyCiChecks } from '../src/integrations/azure/sourceControl.js';
import type { AzPolicyEvaluation } from '../src/integrations/azure/azureDevOpsApi.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { CiCheck, Decision, Escalation, PullRequest, WorldSnapshot } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

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
    agentHeadroom: 5,
    recentDecisions: [],
    ...extra,
  };
}

function checks(...pairs: Array<[string, CiCheck['status']]>): CiCheck[] {
  return pairs.map(([name, status]) => ({ name, status }));
}

const policy = (...rules: CiPolicy['checks']): CiPolicy => ({ checks: rules });

test('matchesCheckGlob: * spans, ? is one, everything else is literal', () => {
  assert.equal(matchesCheckGlob('lint', 'lint'), true);
  assert.equal(matchesCheckGlob('lint', 'lint-ts'), false);
  assert.equal(matchesCheckGlob('test (*)', 'test (18)'), true);
  assert.equal(matchesCheckGlob('test (*)', 'test (20, ubuntu)'), true);
  assert.equal(matchesCheckGlob('test (*)', 'build'), false);
  assert.equal(matchesCheckGlob('node-??', 'node-18'), true);
  assert.equal(matchesCheckGlob('node-??', 'node-8'), false);
  assert.equal(matchesCheckGlob('build.prod', 'build.prod'), true);
  assert.equal(matchesCheckGlob('build.prod', 'buildXprod'), false);
});

test('matchesCheckGlob: case-insensitive, because a check name is a label someone typed elsewhere', () => {
  assert.equal(matchesCheckGlob('Deploy-Preview', 'deploy-preview'), true);
  assert.equal(matchesCheckGlob('deploy-*', 'Deploy-Staging'), true);
});

test('classifyCiFailures: no per-check detail is actionable — the pre-policy behaviour', () => {
  const withNothing = classifyCiFailures(undefined, policy({ match: 'lint', onFailure: 'ignore' }));
  assert.equal(withNothing.actionable, true);
  assert.deepEqual(withNothing.dispatch, []);
  assert.deepEqual(withNothing.ignored, []);

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

test('classifyCiFailures: an advisory failing check is never classified', () => {
  const v = classifyCiFailures([{ name: 'Comment requirements', status: 'failing', advisory: true }], policy());
  assert.deepEqual(v.dispatch, []);
  assert.deepEqual(v.escalate, []);
  assert.deepEqual(v.ignored, []);
  assert.equal(v.actionable, false);
});

test('classifyCiFailures: no checks reported at all stays actionable', () => {
  assert.equal(classifyCiFailures(undefined, policy()).actionable, true);
  assert.equal(classifyCiFailures([], policy()).actionable, true);
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

test('classifyWatchedChecks: a pending check is watched by nobody until a rule says so', () => {
  const pending = checks(['pr-agent-review/reviewed', 'pending']);
  assert.deepEqual(classifyWatchedChecks(pending, policy()).watched, []);
  assert.deepEqual(classifyWatchedChecks(pending, policy({ match: '*', onFailure: 'dispatch' })).watched, []);
});

test('classifyWatchedChecks: a rule watching pending claims it, and the failing verdict is untouched', () => {
  const pending = checks(['pr-agent-review/reviewed', 'pending']);
  const ci = policy({
    match: 'pr-agent-review*',
    states: ['pending'],
    onFailure: 'dispatch',
    guidance: 'Run `/pr-agent-review` on this branch.',
  });

  const watched = classifyWatchedChecks(pending, ci);
  assert.deepEqual(
    watched.watched.map((m) => m.name),
    ['pr-agent-review/reviewed'],
  );
  assert.deepEqual(classifyCiFailures(pending, ci), {
    actionable: false,
    dispatch: [],
    escalate: [],
    ignored: [],
    urgent: false,
  });
});

test('classifyWatchedChecks: `states` scopes the whole rule, so the same check failing falls through', () => {
  const ci = policy({ match: 'pr-agent-review*', states: ['pending'], onFailure: 'dispatch' });
  const failing = classifyCiFailures(checks(['pr-agent-review/reviewed', 'failing']), ci);
  assert.equal(failing.actionable, true);
  assert.deepEqual(
    failing.dispatch.map((m) => ({ name: m.name, claimed: m.rule !== null })),
    [{ name: 'pr-agent-review/reviewed', claimed: false }],
  );
});

test('classifyWatchedChecks: a rule listing both states claims the check in either', () => {
  const ci = policy({ match: 'gate', states: ['failing', 'pending'], onFailure: 'dispatch' });
  assert.equal(classifyWatchedChecks(checks(['gate', 'pending']), ci).watched.length, 1);
  assert.equal(classifyCiFailures(checks(['gate', 'failing']), ci).dispatch.length, 1);
});

test('classifyWatchedChecks: an advisory pending check is never claimed, not even by `*`', () => {
  const v = classifyWatchedChecks(
    [{ name: 'Comment requirements', status: 'pending', advisory: true }],
    policy({ match: '*', states: ['pending'], onFailure: 'dispatch' }),
  );
  assert.deepEqual(v.watched, []);
});

test('classifyWatchedChecks: a passing check is watched by nothing, whatever the rules say', () => {
  const v = classifyWatchedChecks(
    checks(['gate', 'passing']),
    policy({ match: '*', states: ['failing', 'pending'], onFailure: 'dispatch' }),
  );
  assert.deepEqual(v.watched, []);
});

test('classifyWatchedChecks: first match wins, so an earlier rule shadows a broad watch', () => {
  const v = classifyWatchedChecks(
    checks(['gate-a', 'pending'], ['gate-b', 'pending']),
    policy(
      { match: 'gate-a', states: ['failing', 'pending'], onFailure: 'ignore' },
      { match: 'gate-*', states: ['pending'], onFailure: 'dispatch' },
    ),
  );
  assert.deepEqual(
    v.watched.map((m) => m.name),
    ['gate-b'],
  );
});

test('classifyWatchedChecks: a glob matches an alias the provider reports', () => {
  const v = classifyWatchedChecks(
    [{ name: 'pr-agent-review/reviewed', status: 'pending', aliases: ['PR-Agent-Reviewed'] }],
    policy({ match: 'PR-Agent-Review*', states: ['pending'], onFailure: 'dispatch' }),
  );
  assert.deepEqual(
    v.watched.map((m) => m.name),
    ['pr-agent-review/reviewed'],
    'matched by the visible label, but still named by the key the harness stores',
  );
  const failing = classifyCiFailures(
    [{ name: 'pr-agent-review/reviewed', status: 'failing', aliases: ['PR-Agent-Reviewed'] }],
    policy({ match: 'PR-Agent-Reviewed', onFailure: 'ignore' }),
  );
  assert.deepEqual(
    failing.ignored.map((m) => m.name),
    ['pr-agent-review/reviewed'],
  );
});

test('classifyWatchedChecks: urgent rides on a watched check, as it does on a failing one', () => {
  const v = classifyWatchedChecks(
    checks(['gate', 'pending']),
    policy({ match: 'gate', states: ['pending'], onFailure: 'dispatch', urgent: true }),
  );
  assert.equal(v.urgent, true);
});

test('ciWatchNote: names each waiting check, its guidance, and whether it holds the merge', () => {
  const v = classifyWatchedChecks(
    [
      { name: 'pr-agent-review/reviewed', status: 'pending', blocking: true },
      { name: 'optional-scan', status: 'pending', blocking: false },
    ],
    policy(
      { match: 'pr-agent-review*', states: ['pending'], onFailure: 'dispatch', guidance: 'Run `/pr-agent-review`.' },
      { match: 'optional-*', states: ['pending'], onFailure: 'dispatch' },
    ),
  );
  const note = ciWatchNote(v);
  assert.match(note, /pr-agent-review\/reviewed: Run `\/pr-agent-review`\./);
  assert.match(note, /- optional-scan$/m);
  assert.match(note, /do not block the merge — optional-scan/);
  assert.equal(ciWatchNote(classifyWatchedChecks(checks(['gate', 'pending']), policy())), '');
});

test('validateCiPolicy: guidance on a rule that never dispatches is refused, not discarded', () => {
  assert.throws(
    () => validateCiPolicy(policy({ match: 'lint', guidance: 'Run the lint skill.' })),
    /guidance.*discarded/s,
  );
  assert.throws(
    () => validateCiPolicy(policy({ match: 'lint', onFailure: 'escalate', guidance: 'Run it.' })),
    /guidance/,
  );
  validateCiPolicy(policy({ match: 'lint', onFailure: 'dispatch', guidance: 'Run it.' }));
});

test('validateCiPolicy: urgent without a dispatch orders a queue nothing is in', () => {
  assert.throws(() => validateCiPolicy(policy({ match: 'lint', urgent: true })), /urgent/);
});

test('validateCiPolicy: a bad match or onFailure fails at load', () => {
  assert.throws(() => validateCiPolicy(policy({ match: '' })), /non-empty glob/);
  assert.throws(() => validateCiPolicy(policy({ match: 'lint', onFailure: 'dispatchh' as never })), /not one of/);
});

test('validateCiPolicy: a states list that could never fire is refused at load', () => {
  assert.throws(() => validateCiPolicy(policy({ match: 'gate', states: [], onFailure: 'dispatch' })), /at least one/);
  assert.throws(
    () => validateCiPolicy(policy({ match: 'gate', states: ['queued' as never], onFailure: 'dispatch' })),
    /not one of failing \| pending/,
  );
  assert.throws(
    () => validateCiPolicy(policy({ match: 'gate', states: ['passing' as never], onFailure: 'dispatch' })),
    /asks nothing of anyone/,
  );
  assert.throws(
    () => validateCiPolicy(policy({ match: 'gate', states: ['pending'], onFailure: 'escalate' })),
    /no escalation arm for a check that is merely waiting/,
  );
  validateCiPolicy(policy({ match: 'gate', states: ['pending'], onFailure: 'dispatch', guidance: 'Run it.' }));
  validateCiPolicy(policy({ match: 'gate', states: ['failing', 'pending'], onFailure: 'ignore' }));
  validateCiPolicy(policy({ match: 'gate', states: ['pending'], onFailure: 'ignore' }));
  validateCiPolicy(policy({ match: 'gate', states: ['pending'] }));
});

test('loadConfig: the ci block defaults to empty, round-trips, and is validated at load', () => {
  assert.deepEqual(loadConfig().ci, { checks: [] });

  const rules = [{ match: 'deploy-*', onFailure: 'ignore' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: rules } }).ci.checks, rules);

  assert.throws(() => loadConfig({ ci: { checks: [{ match: 'lint', guidance: 'x' }] } }), /guidance/);

  const gate = [{ match: 'pr-agent-review*', states: ['pending' as const], onFailure: 'dispatch' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: gate } }).ci.checks, gate);
  const mute = [{ match: 'gate', states: ['pending' as const], onFailure: 'ignore' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: mute } }).ci.checks, mute);
  assert.throws(
    () => loadConfig({ ci: { checks: [{ match: 'gate', states: ['pending' as never], onFailure: 'escalate' }] } }),
    /never fire/,
  );
});

async function decide(prs: PullRequest[], ci: CiPolicy, extra: Partial<DispatchContext> = {}) {
  const dispatcher = new RuleDispatcher({ defaultBranch: 'main', ci });
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
  assert.match(String(escalations[0]!.context.detail ?? ''), /infra-gate/);
  assert.match(escalations[0]!.prompt, /told the harness not to act on/);

  const open = [{ context: { originRef: 'pr:7:ci' } } as Escalation];
  const second = await decide(prs, ci, { openEscalations: open });
  assert.equal(
    second.actions.some((a) => a.type === 'escalate_to_human'),
    false,
  );

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
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'pr:9:ci');
  assert.equal(
    result.upcoming?.some((q) => q.origin === 'pr:5:ci'),
    true,
  );
});

test('rule `pr-ci-failing`: an urgent check still jumps the queue on a PR that also has a review open', async () => {
  const urgentAndReviewed = pr(9, {
    ciChecks: checks(['security-scan', 'failing']),
    unresolvedComments: [{ id: 'c1', author: 'someone', body: 'different approach please', handled: false }],
  });
  const result = await decide(
    [pr(5, { ciChecks: checks(['lint', 'failing']) }), urgentAndReviewed],
    policy({ match: 'security-*', onFailure: 'dispatch', urgent: true }, { match: 'lint', onFailure: 'dispatch' }),
    { agentHeadroom: 1 },
  );

  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'pr:9:comments', 'the review is what the agent is sent for');
  assert.equal(dispatched[0]!.rule, 'pr-review-comment');
  assert.equal(
    result.upcoming?.some((q) => q.origin === 'pr:5:ci'),
    true,
    'the non-urgent PR lost the one slot, and is still visible in the queue',
  );
});

test('rule `pr-ci-failing`: a stacked PR whose base is red is still suppressed, policy or no policy', async () => {
  const base = pr(1, { branch: 'feature/1', ciChecks: checks(['lint', 'failing']) });
  const child = pr(2, { branch: 'feature/2', baseBranch: 'feature/1', ciChecks: checks(['lint', 'failing']) });
  const result = await decide([base, child], policy({ match: 'lint', onFailure: 'dispatch' }));
  const origins = result.actions.filter((a) => a.type === 'dispatch_code_agent').map((a) => a.originRef);
  assert.deepEqual(origins, ['pr:1:ci']);
});

const GATE = { match: 'pr-agent-review*', states: ['pending' as const], onFailure: 'dispatch' as const };
const gatePr = (over: Partial<PullRequest> = {}) =>
  pr(31676, {
    ciStatus: 'pending',
    ciChecks: [{ name: 'pr-agent-review/reviewed', status: 'pending', blocking: true }],
    ...over,
  });

test('rule `pr-ci-gate`: a watched pending check dispatches, on its own origin', async () => {
  const result = await decide([gatePr()], policy({ ...GATE, guidance: 'Run `/pr-agent-review` on this branch.' }));
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.rule, 'pr-ci-gate');
  assert.equal(dispatched[0]!.originRef, 'pr:31676:ci-gate');
  assert.match(dispatched[0]!.prompt, /waiting, not failing/);
  assert.doesNotMatch(dispatched[0]!.prompt, /Investigate the failure/);
  assert.match(dispatched[0]!.prompt, /pr-agent-review\/reviewed: Run `\/pr-agent-review` on this branch\./);
});

test('rule `pr-ci-gate`: nothing fires without the rule, which is every config that predates it', async () => {
  const result = await decide([gatePr()], policy({ match: 'pr-agent-review*', onFailure: 'dispatch' }));
  assert.equal(
    result.actions.some((a) => a.type === 'dispatch_code_agent' || a.type === 'escalate_to_human'),
    false,
    'a rule left on the default `states: ["failing"]` does not see a pending check',
  );
});

test('rule `pr-ci-gate`: a red build on the same PR outranks the gate for the one agent', async () => {
  const both = gatePr({
    ciStatus: 'failing',
    ciChecks: [
      { name: 'pr-agent-review/reviewed', status: 'pending', blocking: true },
      { name: 'Build-dotnet', status: 'failing', blocking: true },
    ],
  });
  const result = await decide([both], policy(GATE));
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'pr:31676:ci');
  assert.equal(dispatched[0]!.rule, 'pr-ci-failing');
});

test('rule `pr-ci-gate`: suppressed on a stack rung whose base is the one that is red', async () => {
  const base = pr(1, { branch: 'feature/1', ciStatus: 'failing', ciChecks: checks(['Build-dotnet', 'failing']) });
  const child = pr(2, {
    branch: 'feature/2',
    baseBranch: 'feature/1',
    ciStatus: 'failing',
    ciChecks: [
      { name: 'Build-dotnet', status: 'failing', blocking: true },
      { name: 'pr-agent-review/reviewed', status: 'pending', blocking: true },
    ],
  });
  const origins = (await decide([base, child], policy(GATE))).actions
    .filter((a) => a.type === 'dispatch_code_agent')
    .map((a) => a.originRef);
  assert.deepEqual(origins, ['pr:1:ci']);
});

test('rule `pr-ci-gate`: each rung of a healthy stack keeps its own gate', async () => {
  const bottom = gatePr({ number: 1, id: 'pr_1', branch: 'feature/1' });
  const top = gatePr({ number: 2, id: 'pr_2', branch: 'feature/2', baseBranch: 'feature/1' });
  const origins = (await decide([bottom, top], policy(GATE))).actions
    .filter((a) => a.type === 'dispatch_code_agent')
    .map((a) => a.originRef);
  assert.deepEqual(origins, ['pr:1:ci-gate', 'pr:2:ci-gate']);
});

test('rule `pr-ci-gate`: the attempt cap ends the loop a still-pending gate would otherwise run', async () => {
  const attempt = (createdAt: string): Decision =>
    ({
      outcome: 'executed',
      action: { type: 'dispatch_code_agent', originRef: 'pr:31676:ci-gate' },
      createdAt,
    }) as unknown as Decision;
  const spent = [
    attempt('2026-07-28T09:00:00.000Z'),
    attempt('2026-07-28T10:00:00.000Z'),
    attempt('2026-07-28T11:00:00.000Z'),
  ];

  const result = await decide([gatePr()], policy(GATE), { recentDecisions: spent });
  assert.equal(
    result.actions.some((a) => a.type === 'dispatch_code_agent'),
    false,
    'the fourth attempt is not made',
  );
  const escalations = result.actions.filter((a) => a.type === 'escalate_to_human');
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0]!.admission, 'cooldown-escalate');
  assert.equal(escalations[0]!.context.originRef, 'pr:31676:ci-gate');

  const red = gatePr({
    ciStatus: 'failing',
    ciChecks: [{ name: 'Build-dotnet', status: 'failing', blocking: true }],
  });
  const other = await decide([red], policy(GATE), { recentDecisions: spent });
  assert.equal(other.actions.filter((a) => a.type === 'dispatch_code_agent').map((a) => a.originRef)[0], 'pr:31676:ci');
});

test('rule `pr-ci-gate`: a waiting check never stops rule `pr-merge-ready` merging', async () => {
  const mergeable = pr(31676, {
    ciStatus: 'passing',
    approved: true,
    mergeable: true,
    mergeableState: 'clean',
    ciChecks: [{ name: 'pr-agent-review/reviewed', status: 'pending', blocking: false }],
  });
  const result = await decide([mergeable], policy(GATE));
  assert.equal(
    result.actions.some((a) => a.type === 'merge_pr' && a.prNumber === 31676),
    true,
  );
});

test('prHealth: names the failing checks, and caps a matrix so the row stays readable', () => {
  assert.deepEqual(prHealth(pr(7, { ciChecks: checks(['lint', 'failing'], ['build', 'passing']) })).reasons, [
    'CI failing: lint',
  ]);
  assert.deepEqual(prHealth(pr(7)).reasons, ['CI failing']);

  const many = checks(...(['a', 'b', 'c', 'd', 'e'].map((n) => [n, 'failing']) as Array<[string, CiCheck['status']]>));
  assert.deepEqual(prHealth(pr(7, { ciChecks: many })).reasons, ['CI failing: a, b, c +2 more']);
});

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

  assert.deepEqual(listPolicyCiChecks(evals), [
    { name: 'CI build', status: 'failing', blocking: true },
    { name: 'optional build', status: 'failing', blocking: false },
  ]);
  assert.equal(aggregatePolicyCiStatus(evals), 'failing');
  assert.equal(aggregatePolicyCiStatus([evals[1]!]), 'unknown');
});

test('/api/state ships the classification verdict, from the same call the dispatcher makes', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildSystem } = await import('../src/system.js');
  const { FakePtyBackend } = await import('../src/pty/fakeBackend.js');
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');

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
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      ci,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );

  const checks: CiCheck[] = [
    { name: 'unit', status: 'failing' },
    { name: 'deploy/preview', status: 'failing' },
    { name: 'flaky-suite', status: 'failing' },
  ];
  const world = await system.connector.getState();
  system.store.world.setWorldBaseline({
    ...world,
    pullRequests: [pr(31, { ciStatus: 'failing', ciChecks: checks })],
  });

  const snapshot = buildStateSnapshot(system);
  const shipped = snapshot.world.pullRequests.find((p) => p.number === 31)!.ciVerdict;
  assert.deepEqual(shipped, classifyCiFailures(checks, ci));
  system.store.close?.();
});

test('describeCiPolicy: an empty policy still states the unmatched routing', () => {
  const described = describeCiPolicy(loadConfig());
  assert.deepEqual(described, { rules: [], unmatched: 'dispatch', policyKinds: null });
});

test('describeCiPolicy: an omitted onFailure is reported as the inherited ignore', () => {
  const described = describeCiPolicy(
    loadConfig({
      ci: {
        checks: [
          { match: 'deploy-*' },
          { match: 'lint', onFailure: 'dispatch', guidance: 'run npm run format', urgent: true },
          { match: 'flaky-*', onFailure: 'escalate' },
        ],
      },
    }),
  );

  assert.deepEqual(described.rules, [
    {
      match: 'deploy-*',
      states: ['failing'],
      statesInherited: true,
      onFailure: 'ignore',
      inherited: true,
      guidance: null,
      urgent: false,
    },
    {
      match: 'lint',
      states: ['failing'],
      statesInherited: true,
      onFailure: 'dispatch',
      inherited: false,
      guidance: 'run npm run format',
      urgent: true,
    },
    {
      match: 'flaky-*',
      states: ['failing'],
      statesInherited: true,
      onFailure: 'escalate',
      inherited: false,
      guidance: null,
      urgent: false,
    },
  ]);
  assert.deepEqual(
    described.rules.map((r) => r.match),
    ['deploy-*', 'lint', 'flaky-*'],
  );
});

test('describeCiPolicy: the states a rule watches are reported, default and explicit alike', () => {
  const described = describeCiPolicy(
    loadConfig({
      ci: {
        checks: [
          { match: 'pr-agent-review*', states: ['pending'], onFailure: 'dispatch', guidance: 'Run it.' },
          { match: 'lint', onFailure: 'dispatch' },
        ],
      },
    }),
  );
  assert.deepEqual(described.rules[0]?.states, ['pending']);
  assert.equal(described.rules[0]?.statesInherited, false);
  assert.deepEqual(described.rules[1]?.states, ['failing']);
  assert.equal(described.rules[1]?.statesInherited, true);
});

test('describeCiPolicy: policy kinds are Azure-only, and a partial map merges over the defaults', () => {
  assert.equal(
    describeCiPolicy(loadConfig({ integrations: { sourceControl: 'github', issues: 'fake', pool: 'fake' } }))
      .policyKinds,
    null,
  );

  const kinds = describeCiPolicy(
    loadConfig({
      integrations: { sourceControl: 'azure', issues: 'fake', pool: 'fake' },
      azureDevOps: { organization: 'org', project: 'proj', repository: 'repo', policyChecks: { workItems: 'check' } },
    }),
  ).policyKinds;

  assert.deepEqual(
    kinds?.find((k) => k.kind === 'workItems'),
    { kind: 'workItems', mode: 'check', isDefault: false },
  );
  assert.deepEqual(
    kinds?.find((k) => k.kind === 'build'),
    { kind: 'build', mode: 'check', isDefault: true },
  );
  assert.deepEqual(
    kinds?.find((k) => k.kind === 'comments'),
    { kind: 'comments', mode: 'advisory', isDefault: true },
  );
  assert.deepEqual(
    kinds?.find((k) => k.kind === 'reviewers'),
    { kind: 'reviewers', mode: 'off', isDefault: true },
  );
});
