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
  // Detail was reported and nothing in it is actionable — not the "no checks
  // reported at all" silence, so no rule should dispatch a code agent over this.
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

// --------------------------------------------------------------------------
// Watched states (`states`) — the gate that sits pending forever
// --------------------------------------------------------------------------

test('classifyWatchedChecks: a pending check is watched by nobody until a rule says so', () => {
  const pending = checks(['pr-agent-review/reviewed', 'pending']);
  // The default is `['failing']`, so every rule written before `states` existed —
  // and `match: '*'` itself — leaves a pending check exactly where it was.
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
  // The failing classification is the merge-facing answer and must not have
  // moved: nothing is failing here, so dispatch/escalate/ignored stay empty —
  // but detail *was* reported and none of it is failing, so this is not the
  // "no checks reported at all" silence and `actionable` is false.
  assert.deepEqual(classifyCiFailures(pending, ci), {
    actionable: false,
    dispatch: [],
    escalate: [],
    ignored: [],
    urgent: false,
  });
});

test('classifyWatchedChecks: `states` scopes the whole rule, so the same check failing falls through', () => {
  // The rule watches `pending` only. When the check goes red it claims nothing,
  // and the red one takes the unmatched routing — dispatch, with the generic
  // CI-fix prompt. That is the point of scoping rather than extending: one check
  // can have a gate rule and a failure rule, and they say different things.
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
  // `states` cannot name `passing` (validation refuses it), so the only thing
  // that could claim one is a bug in the walk. Asserted rather than assumed.
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
      // Claims `gate-a` in the pending state and does nothing with it — the
      // operator's way of exempting one check from the glob below.
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
  // The Azure status-policy case: the harness keys the check by
  // `statusGenre/statusName`, but the label on the PR page — the string an
  // operator copies into their config — is `defaultDisplayName`.
  const v = classifyWatchedChecks(
    [{ name: 'pr-agent-review/reviewed', status: 'pending', aliases: ['PR-Agent-Reviewed'] }],
    policy({ match: 'PR-Agent-Review*', states: ['pending'], onFailure: 'dispatch' }),
  );
  assert.deepEqual(
    v.watched.map((m) => m.name),
    ['pr-agent-review/reviewed'],
    'matched by the visible label, but still named by the key the harness stores',
  );
  // And the same alias works on the failing side, through the one shared matcher.
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
  // A check with no guidance is still named — the agent cannot act on a gate it
  // cannot see.
  assert.match(note, /- optional-scan$/m);
  assert.match(note, /do not block the merge — optional-scan/);
  // Nothing watched, nothing appended.
  assert.equal(ciWatchNote(classifyWatchedChecks(checks(['gate', 'pending']), policy())), '');
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

test('validateCiPolicy: a states list that could never fire is refused at load', () => {
  // Empty: claims nothing.
  assert.throws(() => validateCiPolicy(policy({ match: 'gate', states: [], onFailure: 'dispatch' })), /at least one/);
  // A typo, and the near-miss that is a real state but not a watchable one.
  assert.throws(
    () => validateCiPolicy(policy({ match: 'gate', states: ['queued' as never], onFailure: 'dispatch' })),
    /not one of failing \| pending/,
  );
  assert.throws(
    () => validateCiPolicy(policy({ match: 'gate', states: ['passing' as never], onFailure: 'dispatch' })),
    /asks nothing of anyone/,
  );
  // `escalate` on a non-failing watch has no arm to run in: rule `pr-ci-blocked`
  // asks about a red PR whose failures are all held, not about a waiting gate.
  assert.throws(
    () => validateCiPolicy(policy({ match: 'gate', states: ['pending'], onFailure: 'escalate' })),
    /no escalation arm for a check that is merely waiting/,
  );
  // The legal shapes pass: the gate rule itself, a rule that still covers failing,
  // and — since the expiry default gave it a job — a pending-only `ignore`, which
  // shadows that default without muting the same check's failures.
  validateCiPolicy(policy({ match: 'gate', states: ['pending'], onFailure: 'dispatch', guidance: 'Run it.' }));
  validateCiPolicy(policy({ match: 'gate', states: ['failing', 'pending'], onFailure: 'ignore' }));
  validateCiPolicy(policy({ match: 'gate', states: ['pending'], onFailure: 'ignore' }));
  validateCiPolicy(policy({ match: 'gate', states: ['pending'] }));
});

test('loadConfig: the ci block defaults to empty, round-trips, and is validated at load', () => {
  assert.deepEqual(loadConfig().ci, { checks: [] });

  const rules = [{ match: 'deploy-*', onFailure: 'ignore' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: rules } }).ci.checks, rules);

  // The refusal is at load, not at the first red PR days later.
  assert.throws(() => loadConfig({ ci: { checks: [{ match: 'lint', guidance: 'x' }] } }), /guidance/);

  const gate = [{ match: 'pr-agent-review*', states: ['pending' as const], onFailure: 'dispatch' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: gate } }).ci.checks, gate);
  // A pending-only `ignore` is legal — it shadows the expiry default — and still
  // round-trips; only `escalate` has no arm to reach.
  const mute = [{ match: 'gate', states: ['pending' as const], onFailure: 'ignore' as const }];
  assert.deepEqual(loadConfig({ ci: { checks: mute } }).ci.checks, mute);
  assert.throws(
    () => loadConfig({ ci: { checks: [{ match: 'gate', states: ['pending' as never], onFailure: 'escalate' }] } }),
    /never fire/,
  );
});

// --------------------------------------------------------------------------
// Rule `pr-ci-failing`, through the dispatcher
// --------------------------------------------------------------------------

async function decide(prs: PullRequest[], ci: CiPolicy, extra: Partial<DispatchContext> = {}) {
  const dispatcher = new RuleDispatcher({}, {}, undefined, 'main', {}, ci);
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
  // Which checks, in the body rather than the lede: the list has no bound, and a
  // PR red on nine escalate-only checks would otherwise put all nine in the first
  // sentence. The prompt says *that* they are all left alone; the body says which.
  assert.match(String(escalations[0]!.context.detail ?? ''), /infra-gate/);
  assert.match(escalations[0]!.prompt, /told the harness not to act on/);

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

test('rule `pr-ci-failing`: an urgent check still jumps the queue on a PR that also has a review open', async () => {
  // `urgent` is carried by the CI concern, which stopped being the top concern
  // when the review comment moved ahead of it. Read off the winner it would
  // silently become conditional on nobody having commented — so it is read off
  // every concern on the PR. The agent still goes out for the review; only the
  // PR's position in the queue is the flag's business.
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

// --------------------------------------------------------------------------
// Rule `pr-ci-gate` — the check that waits rather than fails
// --------------------------------------------------------------------------

/** The motivating case: a blocking Azure status policy sitting `queued` on a green PR. */
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
  // Not `pr:31676:ci`: a stalled gate and a broken build are different problems
  // and must not share one attempt budget.
  assert.equal(dispatched[0]!.originRef, 'pr:31676:ci-gate');
  // The gate prompt, not the red-build one — and the guidance appended after it.
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
  // One agent works a branch, and a thing that broke outranks a thing that has
  // not happened yet. The gate is not lost — it is re-raised every pulse, and
  // wins the branch once the build is fixed.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'pr:31676:ci');
  assert.equal(dispatched[0]!.rule, 'pr-ci-failing');
});

test('rule `pr-ci-gate`: suppressed on a stack rung whose base is the one that is red', async () => {
  // The rung's real problem is the red PR underneath it. Putting an agent on its
  // gate as well is the multiplication `inheritedCiFailure` exists to stop.
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
  // A status policy is evaluated per pull request, so a stack with no red build
  // genuinely has one gate per rung and each needs the command run against it.
  const bottom = gatePr({ number: 1, id: 'pr_1', branch: 'feature/1' });
  const top = gatePr({ number: 2, id: 'pr_2', branch: 'feature/2', baseBranch: 'feature/1' });
  const origins = (await decide([bottom, top], policy(GATE))).actions
    .filter((a) => a.type === 'dispatch_code_agent')
    .map((a) => a.originRef);
  assert.deepEqual(origins, ['pr:1:ci-gate', 'pr:2:ci-gate']);
});

test('rule `pr-ci-gate`: the attempt cap ends the loop a still-pending gate would otherwise run', async () => {
  // The re-dispatch hazard this rule has and the CI rule does not: an agent can
  // run `/pr-agent-review` correctly and the check can *still* be queued next
  // pulse, because clearing it is not the agent's to do. Nothing about the world
  // changes, so the concern is raised again — and the origin's own attempt cap is
  // what stops that being forever.
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

  // And the budget is genuinely the gate's own: three spent attempts at the gate
  // leave a red build on the same PR free to dispatch, which is the whole reason
  // the two do not share an origin.
  const red = gatePr({
    ciStatus: 'failing',
    ciChecks: [{ name: 'Build-dotnet', status: 'failing', blocking: true }],
  });
  const other = await decide([red], policy(GATE), { recentDecisions: spent });
  assert.equal(other.actions.filter((a) => a.type === 'dispatch_code_agent').map((a) => a.originRef)[0], 'pr:31676:ci');
});

test('rule `pr-ci-gate`: a waiting check never stops rule `pr-merge-ready` merging', async () => {
  // The invariant `aggregatePolicyCiStatus` is frozen for. A non-blocking policy
  // that is still queued leaves the PR green, approved and completable by Azure —
  // so the harness must complete it too, gate rule or no gate rule.
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

  const snapshot = buildStateSnapshot(system);
  const shipped = snapshot.world.pullRequests.find((p) => p.number === 31)!.ciVerdict;
  // Asserted against the function itself rather than against a transcribed
  // literal: a second expectation written out by hand is a second implementation
  // of the classifier, and the whole reason this is computed server-side is that
  // two answers to this question drift silently — the floor saying *repair* while
  // the harness held.
  assert.deepEqual(shipped, classifyCiFailures(checks, ci));
  system.store.close?.();
});

// --------------------------------------------------------------------------
// `describeCiPolicy` — what the cockpit's CI tab is shown (issue #244)
// --------------------------------------------------------------------------

test('describeCiPolicy: an empty policy still states the unmatched routing', () => {
  const described = describeCiPolicy(loadConfig());
  // The empty case is the one the tab has to get right: nothing configured does
  // not mean nothing happens, it means every failing check dispatches.
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
    // The value `classifyCiFailures` acts on, not the absent field the file shows.
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
  // Order is the policy's own — first match wins, and the tab numbers them.
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
  // The gate rule's own states, and the fact that they were written rather than
  // inherited — which is what tells an operator a red `pr-agent-review` check is
  // *not* claimed by this rule.
  assert.deepEqual(described.rules[0]?.states, ['pending']);
  assert.equal(described.rules[0]?.statesInherited, false);
  assert.deepEqual(described.rules[1]?.states, ['failing']);
  assert.equal(described.rules[1]?.statesInherited, true);
});

test('describeCiPolicy: policy kinds are Azure-only, and a partial map merges over the defaults', () => {
  // Under GitHub the modes are consulted by nothing, so a table of them would be
  // an answer to a question this harness never asks.
  assert.equal(
    describeCiPolicy(loadConfig({ integrations: { sourceControl: 'github', issues: 'fake' } })).policyKinds,
    null,
  );

  const kinds = describeCiPolicy(
    loadConfig({
      integrations: { sourceControl: 'azure', issues: 'fake' },
      azureDevOps: { organization: 'org', project: 'proj', repository: 'repo', policyChecks: { workItems: 'check' } },
    }),
  ).policyKinds;

  assert.deepEqual(
    kinds?.find((k) => k.kind === 'workItems'),
    { kind: 'workItems', mode: 'check', isDefault: false },
  );
  // Everything the operator did not name keeps its default, and says so.
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
