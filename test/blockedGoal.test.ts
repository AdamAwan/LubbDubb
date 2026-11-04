import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildAskQueue } from '../src/asks/queue.js';
import { validateConclusion } from '../src/mcp/conclusion.js';
import type { Agent } from '../src/types.js';

// → docs/spec/06-issue-pickup.md#blocked-parks-the-goal-for-you

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-blocked-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

async function withIssue(system: System): Promise<void> {
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Make it better', body: 'the thing' });
  system.store.world.setWorldBaseline(await system.connector.getState());
}

function spawnAgent(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Work issue:12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function conclude(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session.call('conclude_work', args)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const pickup = (system: System) => buildStateSnapshot(system).world.issues.find((i) => i.number === 12)!.pickup;
const asks = (system: System) => buildAskQueue(buildStateSnapshot(system));

test('blocked takes a reason, and refuses without one', () => {
  const none = validateConclusion({ status: 'blocked', note: 'got as far as the build' });
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.error, /reason is required/);
  const given = validateConclusion({ status: 'blocked', note: 'got as far as the build', reason: 'main is red' });
  assert.deepEqual(given, { ok: true, verdict: 'blocked', note: 'got as far as the build', reason: 'main is red' });
});

test('a blocked goal parks for the operator, and their release returns it to pickup with the reason', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    await withIssue(system);
    const agent = spawnAgent(system);

    const res = await conclude(system, agent, {
      status: 'blocked',
      reason: 'the base branch fails to build: tsc cannot find module x',
      note: 'wrote the migration, could not run it',
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(system.store.verdicts.getIssueConclusion('issue:12'), null, 'blocked writes no conclusion');
    system.agents.complete(agent.id);

    assert.equal(pickup(system).status, 'parked', 'the goal does not return to pickup');
    assert.equal(pickup(system).eligible, false);
    assert.match(pickup(system).reasons[0] ?? '', /tsc cannot find module x/);

    const [row] = asks(system).filter((r) => r.goalRef === 'issue:12');
    assert.ok(row, 'the operator is asked');
    assert.equal(row.kind, 'escalation');
    assert.equal(row.verb, 'Release');
    assert.match(row.title, /Blocked: the base branch fails to build/);
    assert.equal(row.subject.type, 'escalation');
    const escalationId = row.subject.type === 'escalation' ? row.subject.escalationId : '';
    assert.equal(
      system.store.escalations.getEscalation(escalationId)?.agentId,
      null,
      'the ask names no agent, so the agent finishing does not dismiss it',
    );

    assert.equal(
      system.store.escalations.getEscalation(escalationId)?.status,
      'open',
      'the agent leaving the fleet releases nothing',
    );

    const answered = await app.inject({
      method: 'POST',
      url: `/api/escalations/${escalationId}/answer`,
      payload: { response: 'main is green again, carry on' },
    });
    assert.equal(answered.statusCode, 200, answered.body);

    assert.notEqual(pickup(system).status, 'parked', 'released, the goal is back in pickup');
    assert.equal(
      asks(system).some((r) => r.goalRef === 'issue:12'),
      false,
      'and the ask is gone',
    );
    const [instruction] = system.store.instructions.listStandingInstructions('issue:12');
    assert.match(instruction?.text ?? '', /tsc cannot find module x/, 'the reason goes to the next agent');
    assert.match(instruction?.text ?? '', /main is green again, carry on/, 'beside what the operator said');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('dismissing the ask releases the goal too, with the reason alone', async () => {
  const system = build();
  try {
    await withIssue(system);
    const agent = spawnAgent(system);
    await conclude(system, agent, { status: 'blocked', reason: 'staging is down', note: 'nothing done' });
    system.agents.complete(agent.id);
    assert.equal(pickup(system).status, 'parked');
    const [esc] = system.store.escalations.listOpenEscalations();
    assert.ok(esc);
    system.escalations.dismiss(esc.id);
    assert.notEqual(pickup(system).status, 'parked');
    const [instruction] = system.store.instructions.listStandingInstructions('issue:12');
    assert.match(instruction?.text ?? '', /staging is down/);
  } finally {
    system.store.close();
  }
});

test('a second block on a goal already parked joins the open ask, so its reason is not lost', async () => {
  const system = build();
  try {
    await withIssue(system);
    const first = spawnAgent(system);
    const second = spawnAgent(system);
    await conclude(system, first, { status: 'blocked', reason: 'staging is down', note: 'nothing done' });
    const res = await conclude(system, second, { status: 'blocked', reason: 'the vendor API 500s', note: 'half done' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /operator has been asked/);

    const open = system.store.escalations.listOpenEscalations();
    assert.equal(open.length, 1, 'one goal, one ask');
    assert.match(open[0]!.prompt, /staging is down/);
    assert.match(open[0]!.prompt, /the vendor API 500s/, 'the later reason is in front of the operator');

    system.escalations.dismiss(open[0]!.id);
    const [instruction] = system.store.instructions.listStandingInstructions('issue:12');
    assert.match(instruction?.text ?? '', /staging is down/);
    assert.match(instruction?.text ?? '', /the vendor API 500s/, 'and both go to the next agent');
  } finally {
    system.store.close();
  }
});

test('a block whose issue closed is settled by the harness, and writes no instruction', async () => {
  const system = build();
  try {
    await withIssue(system);
    const agent = spawnAgent(system);
    await conclude(system, agent, { status: 'blocked', reason: 'staging is down', note: 'nothing done' });
    system.agents.complete(agent.id);

    assert.deepEqual(system.escalations.tidyClosedBlocks(await system.connector.getState()), []);
    assert.equal(system.store.escalations.listOpenEscalations().length, 1, 'an open issue keeps its block');

    assert.deepEqual(
      system.escalations.tidyClosedBlocks({ ...(await system.connector.getState()), issues: [], staleSources: ['x'] }),
      [],
      'a stale read settles nothing',
    );

    system.connector.inject({ kind: 'issue_state', number: 12, state: 'closed' });
    const world = await system.connector.getState();
    const settled = system.escalations.tidyClosedBlocks({
      ...world,
      issues: world.issues.filter((i) => i.number !== 12),
    });
    assert.equal(settled.length, 1);
    assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'the ask is off the queue');
    assert.deepEqual(system.store.instructions.listStandingInstructions('issue:12'), [], 'nothing was released');
  } finally {
    system.store.close();
  }
});
