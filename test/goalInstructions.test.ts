import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { operatorInstructionsNote, ticketAmendCommands } from '../src/goalInstructions.js';
import type { Agent, IssueInstruction, Plan } from '../src/types.js';
import { planWithOnePart } from './support/plans.js';
import { findTask } from './support/tasks.js';

function instruction(over: Partial<IssueInstruction> = {}): IssueInstruction {
  return {
    id: 'ins_1',
    originRef: 'issue:1',
    text: 'change the button to primary',
    createdAt: '2026-08-16T09:00:00Z',
    settledAt: null,
    ...over,
  };
}

test('a goal with no standing instruction appends nothing at all', () => {
  assert.equal(operatorInstructionsNote([], 'gh issue edit 1'), '');
});

test('the operator’s words are quoted verbatim and framed as instructions', () => {
  const note = operatorInstructionsNote([instruction()], null);
  assert.match(note, /> change the button to primary/, 'quoted, so the harness is not read as the author');
  assert.match(note, /the operator, 2026-08-16T09:00:00Z/, 'attributed and dated');
  assert.match(note, /\*\*instructions\*\*, not a report/, 'the inverse of the outstanding-work note, and said so');
  assert.match(note, /they win/, 'and they outrank the ticket they postdate');
});

test('several instructions read oldest first, all of them', () => {
  const note = operatorInstructionsNote(
    [
      instruction({ id: 'a', text: 'change the button to primary' }),
      instruction({ id: 'b', text: 'change the permission required', createdAt: '2026-08-16T10:00:00Z' }),
    ],
    null,
  );
  assert.ok(
    note.indexOf('change the button to primary') < note.indexOf('change the permission required'),
    'the order they were written in is the order they read in',
  );
  assert.match(note, /2 times/, 'and the agent is told how many there are');
});

test('a multi-line instruction stays inside its quote', () => {
  const note = operatorInstructionsNote([instruction({ text: 'fix the icon\nit spins forever' })], null);
  assert.match(note, /> fix the icon\n> it spins forever/);
});

test('the note tells the agent to update the ticket, and how', () => {
  const note = operatorInstructionsNote([instruction()], ticketAmendCommands(githubConfig(), 1) ?? '');
  assert.match(note, /Update the ticket when an instruction changes what the goal asks for/);
  assert.match(note, /gh issue view 1 -R acme\/widgets/, 'read first');
  assert.match(note, /gh issue edit 1 -R acme\/widgets --body-file/, 'then write');
  assert.match(note, /do not rewrite what is still true/, 'amend, never replace');
});

test('with no tracker to amend, the note says so instead of naming a command that would fail', () => {
  const note = operatorInstructionsNote([instruction()], null);
  assert.doesNotMatch(note, /gh issue|az boards/);
  assert.match(note, /no issue tracker to update/);
  assert.match(note, /conclude_work note instead/, 'the record it does have');
});

test('the agent is told the instruction is settled by concluding', () => {
  assert.match(operatorInstructionsNote([instruction()], null), /conclude_work settles all of them/);
});

test('the amend commands name the configured tracker, and nothing under the fake provider', () => {
  assert.equal(ticketAmendCommands(loadConfig({ labelPrefix: '', dbPath: ':memory:' }), 1), null);
  const azure = ticketAmendCommands(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      integrations: { issues: 'azure', prs: 'fake' },
      azureDevOps: { organization: 'acme', project: 'Widgets' },
    } as never),
    77,
  );
  assert.match(azure ?? '', /az boards work-item update --org https:\/\/dev\.azure\.com\/acme --id 77/);
  assert.match(azure ?? '', /description is HTML/, 'so an agent does not flatten the markup');
});

function githubConfig(): Config {
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    integrations: { issues: 'github', prs: 'github' },
    github: { owner: 'acme', repo: 'widgets' },
  } as never);
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-ins-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver(),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
    },
  );
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/1',
    originRef,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

test('writing an instruction records the words and the verdict that gets them read', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/1/instruction',
      payload: { text: 'change the button to primary' },
    });
    assert.equal(res.statusCode, 200);

    const standing = system.store.instructions.listStandingInstructions('issue:1');
    assert.equal(standing.length, 1);
    assert.equal(standing[0]?.text, 'change the button to primary');
    const conclusion = system.store.verdicts.getIssueConclusion('issue:1');
    assert.equal(conclusion?.verdict, 'more_work');
    assert.equal(conclusion?.by, 'operator');
    assert.doesNotMatch(conclusion?.note ?? '', /primary/, 'the words live in one place, not two');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('instructions accumulate rather than overwriting each other', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    for (const text of ['change the button to primary', 'change the permission required'])
      await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text } });
    assert.deepEqual(
      system.store.instructions.listStandingInstructions('issue:1').map((i) => i.text),
      ['change the button to primary', 'change the permission required'],
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an empty instruction is refused', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: '  ' } });
    assert.equal(res.statusCode, 400);
    assert.equal(system.store.instructions.listStandingInstructions('issue:1').length, 0);
    assert.equal(system.store.verdicts.getIssueConclusion('issue:1'), null, 'and no verdict is left behind either');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('withdrawing the last instruction takes its verdict with it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'first' } });
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'second' } });
    const [first, second] = system.store.instructions.listStandingInstructions('issue:1');

    const one = await app.inject({ method: 'DELETE', url: `/api/issues/1/instruction/${first?.id}` });
    assert.equal(one.statusCode, 200);
    assert.equal(
      system.store.verdicts.getIssueConclusion('issue:1')?.verdict,
      'more_work',
      'one still stands, so it stays',
    );

    const both = await app.inject({ method: 'DELETE', url: `/api/issues/1/instruction/${second?.id}` });
    assert.equal(both.statusCode, 200);
    assert.equal(
      system.store.verdicts.getIssueConclusion('issue:1'),
      null,
      'nothing left to read, so nothing bounces back',
    );

    const again = await app.inject({ method: 'DELETE', url: `/api/issues/1/instruction/${second?.id}` });
    assert.equal(again.statusCode, 409, 'withdrawing a settled one is refused rather than silently succeeding');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an agent’s own declaration survives a withdrawal', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'change it' } });
    system.store.verdicts.recordIssueConclusion({
      originRef: 'issue:1',
      verdict: 'more_work',
      note: 'the migration is still missing',
      by: 'agent',
    });
    const [only] = system.store.instructions.listStandingInstructions('issue:1');
    await app.inject({ method: 'DELETE', url: `/api/issues/1/instruction/${only?.id}` });
    assert.equal(system.store.verdicts.getIssueConclusion('issue:1')?.by, 'agent', 'left exactly where it was found');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('a standing instruction is in front of the next agent dispatched on the goal', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    await app.inject({
      method: 'POST',
      url: '/api/issues/1/instruction',
      payload: { text: 'change the button to primary' },
    });
    await system.harness.runCycle('manual');

    const task = findTask(system.store, (t) => t.originRef?.startsWith('issue:1') === true);
    assert.ok(task, 'the goal was dispatched');
    assert.match(task.prompt, /change the button to primary/, 'in the operator’s own words');
    assert.match(task.prompt, /What the operator has asked for on this goal/);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an agent on another goal’s pull request is handed none of it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    await app.inject({
      method: 'POST',
      url: '/api/issues/1/instruction',
      payload: { text: 'change the button to primary' },
    });
    system.connector.inject({ kind: 'new_pr', number: 7, title: 'Something else', branch: 'feature/x' });
    system.connector.inject({ kind: 'ci_failed', prNumber: 7 });
    await system.harness.runCycle('manual');

    const prTask = findTask(system.store, (t) => t.originRef?.startsWith('pr:7') === true);
    assert.ok(prTask, 'the CI concern dispatched');
    assert.doesNotMatch(prTask.prompt, /change the button to primary/);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('concluding the goal settles every instruction standing on it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'change the button' } });
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'and the permission' } });
    const agent = spawnAgent(system, 'issue:1');
    const session = system.mcp.session(agent.id);
    assert.ok(session);
    const result = (await session.call('conclude_work', {
      status: 'more_work',
      note: 'did the button, left the permission — it needs a decision',
    })) as { isError?: boolean };
    assert.notEqual(result.isError, true);

    assert.equal(
      system.store.instructions.listStandingInstructions('issue:1').length,
      0,
      'the conclusion is the answer to them, so they do not reach the next agent twice',
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an instruction on a delivered goal takes the park down with it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    system.store.verdicts.recordDelivery({ originRef: 'issue:1', summary: 'assessed as delivered', by: 'assessor' });

    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'the button is wrong' } });
    assert.equal(system.store.verdicts.getDelivery('issue:1'), null, 'the goal is not delivered any more');
    assert.equal(system.store.verdicts.getIssueConclusion('issue:1')?.verdict, 'more_work');

    await system.harness.runCycle('manual');
    const dispatched = system.store.tasks.listTasks().filter((t) => t.originRef?.startsWith('issue:1') === true);
    assert.ok(dispatched.length > 0, 'and an agent is on it');
    assert.ok(
      dispatched.every((t) => t.originRef !== 'issue:1:retro'),
      'not the write-up desk, which has no worktree and could not act on the words if it read them',
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('an instruction on a goal whose plan is finished sends the plan back to a planner', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    const plan = settledPlan(system, 1);
    assert.equal(system.store.plans.getPlan(plan.id)?.status, 'complete', 'the state the funnel used to stop in');

    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'the button is wrong' } });
    assert.equal(system.store.plans.getPlan(plan.id)?.status, 'planning');

    await system.harness.runCycle('manual');
    const replanner = findTask(system.store, (t) => t.originRef === 'issue:1:plan');
    assert.ok(replanner, 'a planner was dispatched');
    assert.match(replanner.title, /Replan issue #1/, 'primed with the plan that exists, not asked to plan it cold');
    assert.match(replanner.prompt, /the button is wrong/, 'and it reads what the operator asked for');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('a plan still in flight is left exactly where it is', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    const plan = planWithOnePart(system.store, 1, 'Ship the thing');
    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'the button is wrong' } });
    assert.equal(system.store.plans.getPlan(plan.id)?.status, 'active');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('the goal in issue #603: delivered, plan complete, written up — and More work restarts it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    settledPlan(system, 1);
    system.store.verdicts.recordDelivery({ originRef: 'issue:1', summary: 'assessed as delivered', by: 'assessor' });
    await system.harness.runCycle('manual');
    assert.ok(
      findTask(system.store, (t) => t.originRef === 'issue:1:retro'),
      'the run was written up',
    );

    await app.inject({ method: 'POST', url: '/api/issues/1/instruction', payload: { text: 'the button is wrong' } });
    await system.harness.runCycle('manual');

    const replanner = findTask(system.store, (t) => t.originRef === 'issue:1:plan');
    assert.ok(replanner, 'a planner is on it');
    assert.match(replanner.prompt, /the button is wrong/, 'and it reads what the operator asked for');
  } finally {
    await app.close();
    system.store.close();
  }
});

function settledPlan(system: System, issueNumber: number): Plan {
  const plan = planWithOnePart(system.store, issueNumber, `Issue #${issueNumber}`);
  const [part] = system.store.plans.listPlanParts(plan.id);
  system.store.plans.markPartDispatched(part!.id, 'task_seed', `issue/${issueNumber}/whole`);
  system.store.plans.concludePlanPart(part!.id, { kind: 'report', ref: null, summary: 'delivered' });
  system.store.plans.rollUpPlanStatus(plan.id);
  return plan;
}
