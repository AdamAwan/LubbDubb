import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { outstandingChecks } from '../src/validation/verdict.js';
import { checkBriefing } from '../src/validation/fleet.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import type { Agent, Issue, IssueDelivery, Plan, ValidationCheck, ValidationCheckAmendment } from '../src/types.js';

/**
 * The fleet hand-over: an operator handing one validation check to the harness's
 * own agents, and what comes back.
 *
 * Three properties are asserted in **both** directions here, because each is one
 * edit away from its dishonest twin:
 *
 * 1. **The hand-over is the whole gate.** A nominated check that nobody handed
 *    over dispatches nothing; a handed-over check that nobody nominated
 *    dispatches. Deriving the dispatch from `fleetCandidate` would be a planner
 *    assigning work against logins it cannot know the deployment has.
 * 2. **A hand-back records no reading.** An agent that could not reach the
 *    environment learned nothing about the goal, and `failed` would flag it for a
 *    reason that has nothing to do with the code.
 * 3. **A rewording withdraws the hand-over as well as the result.** Both were
 *    decisions about wording that no longer exists.
 */

const NOW = '2025-01-01T00:00:00.000Z';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vfleet-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

const CHECK = { id: 'csv-opens', title: 'The export opens in Excel', do: 'Export a report.', expect: 'It opens.' };

function planWith(system: System, checks: Record<string, unknown>[]): string {
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    validation: { checks },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: 'issue:12', title: 'Ship it' });
  // The **goal**, which is what the checks are keyed on — the plan id is not a
  // handle anything about validation takes any more.
  return 'issue:12';
}

/** One check as `amendValidation` takes it — the document's shape, already parsed. */
function amendment(over: Partial<ValidationCheckAmendment> = {}): ValidationCheckAmendment[] {
  return [{ ...CHECK, uses: [], covers: [], fleetCandidate: false, candidateWhy: null, ...over }];
}

function byId(system: System, goal: string, id: string): ValidationCheck {
  const found = system.store.listValidationChecks(goal).find((c) => c.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Ship it',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

// -- the rule, against the dispatcher directly -------------------------------

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'every part merged',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

function plan(): Plan {
  return {
    id: 'plan-12',
    originRef: 'issue:12',
    title: 'Ship it',
    status: 'active',
    reason: 'One fix.',
    diagnosis: null,
    approach: null,
    alternatives: null,
    openQuestions: null,
    risks: null,
    outOfScope: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function check(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    originRef: 'issue:12',
    id: 'csv-opens',
    letter: 'A',
    seq: 1,
    title: 'The export opens in Excel',
    do: 'Export a report and open it.',
    expect: 'It opens with the columns intact.',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    plans: [plan()],
    deliveries: [delivered()],
    ...over,
  };
}

function runner(): RuleDispatcher {
  return new RuleDispatcher({}, {}, undefined, 'main', {}, {}, {}, '/srv/validation');
}

function validateDispatches(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.includes(':validate:'));
}

test('a check the operator handed over is run; one merely nominated is not', async () => {
  const handed = await runner().decide(ctx({ validationChecks: [check({ actor: 'fleet' })] }));
  assert.deepEqual(validateDispatches(handed.actions), ['issue:12:validate:csv-opens']);

  // The whole point of the gate, in the direction that would be easy to get
  // wrong: whether an agent *can* run a check is a property of the deployment,
  // which the planner writing the nomination cannot know.
  const nominated = await runner().decide(
    ctx({ validationChecks: [check({ fleetCandidate: true, candidateWhy: 'no login needed' })] }),
  );
  assert.deepEqual(validateDispatches(nominated.actions), [], 'a nomination dispatches nothing');
});

test('it is a code agent on its own branch, cut from the default branch', async () => {
  const plan = await runner().decide(ctx({ validationChecks: [check({ actor: 'fleet' })] }));
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate:csv-opens');
  assert.equal(action?.type, 'dispatch_code_agent', 'it needs a checkout to run anything');
  const dispatch = action as unknown as { branch: string; base: string; prompt: string };
  // Its own namespace, and the check id on it: git cannot put a ref beneath
  // another ref, and two handed-over checks must not fight over one worktree.
  assert.equal(dispatch.branch, 'validate/issue/12/csv-opens');
  // The delivered work is *on* the default branch, so it is the only checkout in
  // which the check can be run at all.
  assert.equal(dispatch.base, 'main');
});

test('the procedure and the expectation reach the agent, appended rather than interpolated', async () => {
  const plan = await runner().decide(
    ctx({ validationChecks: [check({ actor: 'fleet', uses: ['fixture-repo.tar.gz'] })] }),
  );
  const dispatch = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate:csv-opens') as
    | { prompt: string }
    | undefined;
  assert.ok(dispatch);
  // The half the agent cannot act without. It is appended, so an operator
  // override that predates this rule cannot silently drop it.
  assert.match(dispatch.prompt, /Export a report and open it\./);
  assert.match(dispatch.prompt, /It opens with the columns intact\./);
  assert.match(dispatch.prompt, /fixture-repo\.tar\.gz/);
  // And where to look for what it needs — resolved from the configured root.
  assert.match(dispatch.prompt, /issue-12/);
});

test('nothing is run for a goal that is not delivered, or a check somebody has settled', async () => {
  // A check exercises the *delivered* goal. Run mid-flight it reports a failure
  // about something that does not exist yet.
  const inFlight = await runner().decide(ctx({ deliveries: [], validationChecks: [check({ actor: 'fleet' })] }));
  assert.deepEqual(validateDispatches(inFlight.actions), []);

  for (const state of ['passed', 'failed', 'waived', 'deferred'] as const) {
    const settled = await runner().decide(ctx({ validationChecks: [check({ actor: 'fleet', state })] }));
    assert.deepEqual(validateDispatches(settled.actions), [], `a ${state} check carries somebody's answer already`);
  }

  const withdrawn = await runner().decide(
    ctx({ validationChecks: [check({ actor: 'fleet', supersededReason: 'the screen went' })] }),
  );
  assert.deepEqual(validateDispatches(withdrawn.actions), [], 'a check its own plan withdrew is not asked for');
});

test('two handed-over checks get two origins and two worktrees', async () => {
  const plan = await runner().decide(
    ctx({
      validationChecks: [check({ actor: 'fleet' }), check({ id: 'pdf-prints', letter: 'B', seq: 2, actor: 'fleet' })],
    }),
  );
  assert.deepEqual(validateDispatches(plan.actions), ['issue:12:validate:csv-opens', 'issue:12:validate:pdf-prints']);
  // Per check rather than per goal, `pr-ci-gate`'s split: one budget across every
  // check would let one that can never be run spend the attempts of the rest.
  const branches = plan.actions
    .filter((a) => 'branch' in a && typeof (a as { branch?: unknown }).branch === 'string')
    .map((a) => (a as unknown as { branch: string }).branch)
    .filter((b) => b.startsWith('validate/'));
  assert.deepEqual(branches, ['validate/issue/12/csv-opens', 'validate/issue/12/pdf-prints']);
});

test('it ranks last: a check never takes the slot a pickup wanted', async () => {
  // The standing promise is that validation blocks nothing. A rule that could
  // take the final slot from work would make the one feature that gates nothing
  // the reason something else did not run.
  const plan = await runner().decide(
    ctx({
      agentHeadroom: 1,
      // A second, undelivered issue, so `issue-pickup` has something to claim.
      world: { takenAt: NOW, pullRequests: [], issues: [issue(), issue({ number: 13, title: 'Other' })] },
      validationChecks: [check({ actor: 'fleet' })],
    }),
  );
  assert.deepEqual(validateDispatches(plan.actions), [], 'the pickup took the slot');
  const queued = (plan.upcoming ?? []).find((q) => q.origin === 'issue:12:validate:csv-opens');
  // Queued, not dropped — the cut has to stay visible, or below-cut work looks
  // like work that was never proposed.
  assert.equal(queued?.status, 'waiting');
  assert.equal(queued?.rule, 'validate-check');
});

// -- reporting ---------------------------------------------------------------

test('the dispatched agent records a reading, and it is attributed to the fleet', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);
  system.store.setValidationActor(planId, 'csv-opens', 'fleet');

  const res = await callTool(system, spawnAgent(system, 'issue:12:validate:csv-opens'), 'validation_report', {
    result: 'passed',
    note: 'exported, opened in Excel, seven columns intact',
  });
  assert.equal(res.isError, false);
  assert.equal(res.json().recordedBy, 'agent');

  const after = byId(system, planId, 'csv-opens');
  assert.equal(after.state, 'passed');
  // The fact the operator most needs beside the tick: "an agent says this passed"
  // and "I ran it and it passed" are different things.
  assert.equal(after.resultBy, 'agent');
  assert.equal(after.resultNote, 'exported, opened in Excel, seven columns intact');
});

test('an agent that was not sent to run this check may not report on it, and is told what it wants', async () => {
  const system = build();
  planWith(system, [CHECK]);

  // The narrow fence, unlike `validation_amend`'s: a result is a reading cast
  // about a procedure somebody was asked to carry out. The tempting caller is the
  // one that just built the thing and believes it works.
  for (const origin of ['issue:12', 'issue:12:part:reader', 'issue:12:assess', 'issue:12:plan']) {
    const res = await callTool(system, spawnAgent(system, origin), 'validation_report', {
      result: 'passed',
      note: 'looks right to me',
    });
    assert.equal(res.isError, true, `${origin} was not dispatched to run a check`);
    assert.match(res.text, /validation_amend/, 'and is pointed at the tool it can actually use');
  }
});

test('a hand-back records no reading and returns the check with its reason', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);
  system.store.setValidationActor(planId, 'csv-opens', 'fleet');

  const res = await callTool(system, spawnAgent(system, 'issue:12:validate:csv-opens'), 'validation_report', {
    result: 'handback',
    note: 'the report screen needs a login and I have no browser',
  });
  assert.equal(res.isError, false);
  assert.equal(res.json().reported, 'handback');

  const after = byId(system, planId, 'csv-opens');
  // The whole argument for a third answer: the agent found nothing out about the
  // goal, so recording `failed` would flag it for a reason that is not about the
  // code — and silence would leave an `unrun` check with no account of itself.
  assert.equal(after.state, 'unrun');
  assert.equal(after.resultBy, null);
  assert.equal(after.actor, 'human', 'it is a person’s check again');
  assert.match(after.handbackNote ?? '', /needs a login/);
});

test('a report says what it saw, or it is refused', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);
  system.store.setValidationActor(planId, 'csv-opens', 'fleet');
  const agent = spawnAgent(system, 'issue:12:validate:csv-opens');

  const blank = await callTool(system, agent, 'validation_report', { result: 'passed', note: '   ' });
  assert.equal(blank.isError, true);
  const nonsense = await callTool(system, agent, 'validation_report', { result: 'probably', note: 'fine' });
  assert.equal(nonsense.isError, true);
  assert.equal(byId(system, planId, 'csv-opens').state, 'unrun', 'a refusal writes nothing');
});

test('a check withdrawn while an agent was running it is said plainly, and nothing is written', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);
  system.store.setValidationActor(planId, 'csv-opens', 'fleet');
  const agent = spawnAgent(system, 'issue:12:validate:csv-opens');
  // An amendment landing between the dispatch and the report — not the agent's
  // fault and not something it can fix.
  system.store.amendValidation(planId, {
    checks: [],
    withdraw: [{ id: 'csv-opens', reason: 'the export was dropped' }],
    resources: [],
    note: 'the export went',
  });

  const res = await callTool(system, agent, 'validation_report', { result: 'passed', note: 'it opened' });
  assert.equal(res.isError, true);
  assert.match(res.text, /withdrew it/);
});

// -- the hand-over itself ----------------------------------------------------

test('handing over is an operator act, and a settled check is refused rather than silently ignored', async () => {
  const system = build();
  const goal = planWith(system, [CHECK]);
  const { app } = await buildApp(system);
  // Keyed on the goal, not the plan: `:number` is the issue the check belongs to.
  const url = `/api/issues/12/validation/csv-opens/handover`;

  const handed = await app.inject({ method: 'POST', url, payload: { to: 'fleet' } });
  assert.equal(handed.statusCode, 200);
  assert.equal(byId(system, goal, 'csv-opens').actor, 'fleet');

  // Taking it back is always allowed — it stops something from happening.
  const back = await app.inject({ method: 'POST', url, payload: { to: 'human' } });
  assert.equal(back.statusCode, 200);
  assert.equal(byId(system, goal, 'csv-opens').actor, 'human');

  // The rule only ever runs an `unrun` check, so handing over a settled one would
  // take and then never move. Refused instead, pointing at the undo.
  system.store.recordValidationResult(goal, 'csv-opens', { state: 'passed', note: 'it opened', by: 'operator' });
  const settled = await app.inject({ method: 'POST', url, payload: { to: 'fleet' } });
  assert.equal(settled.statusCode, 400);
  assert.match(settled.body, /reset it first/);
  assert.equal(byId(system, goal, 'csv-opens').actor, 'human');
});

test('a rewording withdraws the hand-over; a word-for-word re-declaration keeps it', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);
  system.store.setValidationActor(planId, 'csv-opens', 'fleet');

  // Identical wording changes nothing about who was asked to run it.
  system.store.amendValidation(planId, { checks: amendment(), withdraw: [], resources: [], note: 'no change' });
  assert.equal(byId(system, planId, 'csv-opens').actor, 'fleet');

  // Reworded, the hand-over goes with the result — both were decisions about
  // wording that no longer exists, and the band is already in front of the
  // operator saying so.
  system.store.amendValidation(planId, {
    checks: amendment({ do: 'Log into the test environment, then export a report.' }),
    withdraw: [],
    resources: [],
    note: 'it needs the test environment now',
  });
  const after = byId(system, planId, 'csv-opens');
  assert.equal(after.actor, 'human');
  assert.equal(after.state, 'unrun');
});

test('the next reading answers a hand-back, exactly as it answers an amendment', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);
  system.store.recordValidationHandback(planId, 'csv-opens', 'no browser');
  assert.match(byId(system, planId, 'csv-opens').handbackNote ?? '', /no browser/);

  system.store.recordValidationResult(planId, 'csv-opens', {
    state: 'passed',
    note: 'I ran it myself',
    by: 'operator',
  });
  assert.equal(byId(system, planId, 'csv-opens').handbackNote, null, 'the operator has moved past it');
});

test('handing a check over again briefs the next agent with the last attempt’s reason', async () => {
  const system = build();
  const planId = planWith(system, [CHECK]);

  system.store.setValidationActor(planId, 'csv-opens', 'fleet');
  system.store.recordValidationHandback(planId, 'csv-opens', 'no login for staging');
  // The operator reads why, fixes the deployment, and sends it again. Without the
  // reason in front of it the next agent hits the same wall and spends one of the
  // three attempts saying what was already on the row.
  const again = system.store.setValidationActor(planId, 'csv-opens', 'fleet');
  assert.ok(again);
  assert.equal(again.actor, 'fleet');
  assert.match(checkBriefing(again), /gave this back before[\s\S]*no login for staging/);

  // And the row itself does not describe the last attempt while this one is out.
  assert.match(outstandingChecks(system.store.listValidationChecks(planId)).join('\n'), /handed to the fleet/);
});

// -- what reaches somebody who is not at the cockpit -------------------------

test('the close-out line says who owes the check, and the ticket says who recorded it', async () => {
  const system = build();
  const goal = planWith(system, [CHECK, { ...CHECK, id: 'pdf-prints', title: 'The PDF prints' }]);
  system.store.setValidationActor(goal, 'csv-opens', 'fleet');
  system.store.recordValidationHandback(goal, 'pdf-prints', 'the printer is not reachable from here');

  const lines = outstandingChecks(system.store.listValidationChecks(goal));
  // Without these, both render as a bare `unrun` — the same word for "nobody has
  // got to it", "an agent is about to" and "an agent tried and could not".
  assert.match(lines.join('\n'), /handed to the fleet/);
  assert.match(lines.join('\n'), /handed back.*printer is not reachable/);

  system.store.recordValidationResult(goal, 'csv-opens', { state: 'passed', note: 'it opened', by: 'agent' });
  const comment = renderPlanComment(
    system.store.getPlanByOrigin(goal) as Plan,
    [],
    system.store.listValidationChecks(goal),
  );
  // The reader of the ticket next month is deciding how much the tick is worth.
  assert.match(comment, /recorded by an agent/);
});
