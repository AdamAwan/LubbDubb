import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { validateHumanTask } from '../src/mcp/humanTasks.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { buildTools } from '../src/mcp/tools.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { partIsHuman } from '../src/plans/parts.js';
import type { Agent, Issue, WorldSnapshot } from '../src/types.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-human-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 5,
    planning: { ...DEFAULT_PLANNING },
    ...overrides,
  });
}

function build(overrides: Record<string, unknown> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Do the thing.',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
    ...overrides,
  };
}

function world(issues: Issue[]): WorldSnapshot {
  return { takenAt: '2026-08-11T12:00:00.000Z', pullRequests: [], issues };
}

function pickupAgent(system: System, originRef = 'issue:12'): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Work issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('a one-line title is the boundary, and the refusal names where the rest goes', () => {
  const ok = validateHumanTask({ title: '  Enable the staging webhook  ', detail: '  Dashboard → Developers  ' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.input, { title: 'Enable the staging webhook', detail: 'Dashboard → Developers' });

  const blob = validateHumanTask({ title: 'Enable the webhook\nThen check it returns 200' });
  assert.ok(!blob.ok);
  assert.match(blob.error, /one line/);
  assert.match(blob.error, /detail/);

  const long = validateHumanTask({ title: 'x'.repeat(161) });
  assert.ok(!long.ok);
  assert.match(long.error, /detail/);

  const empty = validateHumanTask({ title: '   ' });
  assert.ok(!empty.ok);
  assert.match(empty.error, /required/);

  const bare = validateHumanTask({ title: 'Plug the reader into the test rig' });
  assert.ok(bare.ok);
  assert.equal(bare.input.detail, null);
});

test('a human task is created, listed, settled — and survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-human-db-'));
  const dbPath = join(dir, 'store.db');

  const first = new Store(dbPath);
  const { task } = first.recordHumanTask({
    title: 'Rotate the CI deploy key',
    detail: 'Settings → Deploy keys.',
    originRef: 'issue:205',
    agentId: null,
    taskId: null,
  });
  assert.equal(task.status, 'open');
  assert.equal(first.listHumanTasks().length, 1);
  first.close();

  const second = new Store(dbPath);
  const reopened = second.listHumanTasks();
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]!.title, 'Rotate the CI deploy key');
  assert.equal(reopened[0]!.status, 'open');

  const settled = second.settleHumanTask(task.id, 'done', 'Rotated and redeployed.');
  assert.equal(settled?.status, 'done');
  assert.equal(settled?.resolution, 'Rotated and redeployed.');
  assert.ok(settled?.resolvedAt);
  assert.equal(second.settleHumanTask(task.id, 'declined', 'no'), null);
  second.close();
});

test('a repeat refreshes the row rather than filing it twice, and never resets the status', () => {
  const system = build();
  const agent = pickupAgent(system);
  const task = system.store.getTask(agent.taskId)!;

  const first = system.store.recordHumanTask({
    title: 'Enable the webhook',
    detail: 'thin',
    originRef: task.originRef,
    agentId: agent.id,
    taskId: task.id,
  });
  assert.ok(first.created);

  const again = system.store.recordHumanTask({
    title: 'Enable the webhook',
    detail: 'thicker, with the URL',
    originRef: task.originRef,
    agentId: agent.id,
    taskId: task.id,
  });
  assert.equal(again.created, false);
  assert.equal(again.task.id, first.task.id);
  assert.equal(again.task.detail, 'thicker, with the URL');
  assert.equal(system.store.listHumanTasks().length, 1);

  system.store.settleHumanTask(first.task.id, 'declined', 'not until the migration lands');
  system.store.recordHumanTask({
    title: 'Enable the webhook',
    detail: 'asking once more',
    originRef: task.originRef,
    agentId: agent.id,
    taskId: task.id,
  });
  assert.equal(system.store.getHumanTask(first.task.id)!.status, 'declined');
});

test('request_human_task is advertised, and identity is structural', async () => {
  const system = build();
  assert.ok(MCP_TOOL_NAMES.includes('request_human_task'));

  const agent = pickupAgent(system);
  const task = system.store.getTask(agent.taskId)!;
  const tool = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find(
    (t) => t.name === 'request_human_task',
  );
  assert.ok(tool, 'the tool is built, so the name and the module agree');
  const schema = tool.inputSchema as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['detail', 'title']);

  const res = await callTool(system, agent, 'request_human_task', {
    title: 'Enable the staging webhook in the Stripe dashboard',
    detail: 'Dashboard → Developers → Webhooks.',
  });
  assert.equal(res.isError, false);
  const [filed] = system.store.listHumanTasks();
  assert.ok(filed);
  assert.equal(filed!.agentId, agent.id);
  assert.equal(filed!.originRef, 'issue:12', 'the origin comes from the credential, not an argument');
  assert.match(res.text, /Nobody is dispatched/);
});

test('a malformed ask is refused synchronously, and nothing is written', async () => {
  const system = build();
  const agent = pickupAgent(system);
  const res = await callTool(system, agent, 'request_human_task', {
    title: 'Do the thing\nand then the other thing',
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /one line/);
  assert.equal(system.store.listHumanTasks().length, 0);
});

test('nothing in the dispatcher reads human tasks — a standalone one blocks nothing', async () => {
  const system = build();
  system.store.setWorldBaseline(world([issue(12)]));
  const agent = pickupAgent(system);
  await callTool(system, agent, 'request_human_task', { title: 'Look at the rendered screen' });

  const before = system.store.listHumanTasks();
  assert.equal(before.length, 1);
  assert.equal(before[0]!.status, 'open');
  const report = await system.harness.runCycle('manual');
  assert.ok(report, 'a cycle runs with an open human task on the books');
});

test('a plan step for a person is never dispatched, and holds what depends on it', async () => {
  const system = build();
  system.store.setWorldBaseline(world([issue(12)]));

  const { plan } = ingestPlanDocument(system.store, {
    doc: {
      version: 1,
      evidence: [],
      reason: 'The console change has to happen before anything can verify it.',
      parts: [
        {
          slug: 'webhook',
          title: 'Enable the staging webhook',
          scope: 'the Stripe dashboard',
          dependsOn: [],
          expectedKind: 'human',
          acceptance: 'A test event returns 200.',
          touches: [],
        },
        { slug: 'verify', title: 'Assert on the delivered event', scope: 'test/', touches: [], dependsOn: ['webhook'] },
      ],
    },
    originRef: 'issue:12',
    title: 'Issue 12',
  });

  const parts = system.store.listPlanParts(plan.id);
  const step = parts.find((p) => p.slug === 'webhook')!;
  const dependent = parts.find((p) => p.slug === 'verify')!;
  assert.ok(partIsHuman(step));

  const backing = system.store.listHumanTasksForParts([step.id]);
  assert.equal(backing.length, 1);
  assert.equal(backing[0]!.status, 'open');
  assert.equal(backing[0]!.originRef, 'issue:12:part:webhook');
  assert.equal(backing[0]!.agentId, null, 'a planner declared it; no individual agent asked');

  await system.harness.runCycle('manual');
  const dispatched = system.store
    .listTasks()
    .map((t) => t.originRef)
    .filter((r): r is string => r !== null);
  assert.ok(
    !dispatched.includes('issue:12:part:webhook'),
    'no agent is dispatched for a step a person owns — it is not a candidate at all',
  );
  assert.ok(
    !dispatched.includes('issue:12:part:verify'),
    'and its dependent waits: the step has no branch to stack on and has not settled',
  );

  const { app } = await buildApp(system);
  const done = await app.inject({ method: 'POST', url: `/api/human-tasks/${backing[0]!.id}/done` });
  assert.equal(done.statusCode, 200);
  const closed = system.store.listPlanParts(plan.id).find((p) => p.slug === 'webhook')!;
  assert.equal(closed.status, 'concluded');
  assert.equal(closed.outcomeKind, 'human');

  await system.harness.runCycle('manual');
  const after = system.store.listPlanParts(plan.id).find((p) => p.id === dependent.id)!;
  assert.equal(after.status, 'ready', 'once the person has done it, the work behind it is dispatchable');
});

test('declining a step blocks it rather than concluding it, so nothing downstream starts', async () => {
  const system = build();
  system.store.setWorldBaseline(world([issue(12)]));

  const { plan } = ingestPlanDocument(system.store, {
    doc: {
      version: 1,
      evidence: [],
      reason: 'A person has to flip it first.',
      parts: [
        {
          slug: 'flip',
          title: 'Flip the flag in the console',
          scope: 'the console',
          dependsOn: [],
          expectedKind: 'human',
          touches: [],
        },
        { slug: 'verify', title: 'Assert on it', scope: 'test/', touches: [], dependsOn: ['flip'] },
      ],
    },
    originRef: 'issue:12',
    title: 'Issue 12',
  });
  const step = system.store.listPlanParts(plan.id).find((p) => p.slug === 'flip')!;
  const backing = system.store.listHumanTasksForParts([step.id])[0]!;

  const { app } = await buildApp(system);
  const bare = await app.inject({ method: 'POST', url: `/api/human-tasks/${backing.id}/decline`, payload: {} });
  assert.equal(bare.statusCode, 400);

  const declined = await app.inject({
    method: 'POST',
    url: `/api/human-tasks/${backing.id}/decline`,
    payload: { note: 'Not until the migration lands.' },
  });
  assert.equal(declined.statusCode, 200);
  assert.equal(system.store.getHumanTask(backing.id)!.status, 'declined');

  await system.harness.runCycle('manual');
  const after = system.store.listPlanParts(plan.id);
  const stopped = after.find((p) => p.slug === 'flip')!;
  const dependent = after.find((p) => p.slug === 'verify')!;
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.blockedReason ?? '', /declined/);
  assert.notEqual(dependent.status, 'ready');

  const again = await app.inject({
    method: 'POST',
    url: `/api/human-tasks/${backing.id}/decline`,
    payload: { note: 'again' },
  });
  assert.equal(again.statusCode, 409);
});

test('an operator files and settles one through the routes, and the snapshot ships it', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const created = await app.inject({
    method: 'POST',
    url: '/api/human-tasks',
    payload: { title: 'Plug the card reader into the test rig', originRef: 'issue:12' },
  });
  assert.equal(created.statusCode, 200);
  const { humanTask } = created.json() as { humanTask: { id: string; agentId: string | null } };
  assert.equal(humanTask.agentId, null);

  const blob = await app.inject({
    method: 'POST',
    url: '/api/human-tasks',
    payload: { title: 'Do this\nand that' },
  });
  assert.equal(blob.statusCode, 400);

  const state = await app.inject({ method: 'GET', url: '/api/state' });
  const shipped = (state.json() as { humanTasks: { id: string }[] }).humanTasks;
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0]!.id, humanTask.id);

  const done = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/done` });
  assert.equal(done.statusCode, 200);
  assert.equal(system.store.getHumanTask(humanTask.id)!.status, 'done');
  const after = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal((after.json() as { humanTasks: unknown[] }).humanTasks.length, 1);

  assert.equal((await app.inject({ method: 'POST', url: '/api/human-tasks/nope/done' })).statusCode, 409);
});

test('a settled task is dismissed off the bench; an open one cannot be, and nothing else moves', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const created = await app.inject({
    method: 'POST',
    url: '/api/human-tasks',
    payload: { title: 'Plug the card reader into the test rig' },
  });
  const { humanTask } = created.json() as { humanTask: { id: string } };

  const early = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/dismiss` });
  assert.equal(early.statusCode, 409);
  assert.equal(system.store.getHumanTask(humanTask.id)!.dismissedAt, null);

  await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/done`, payload: { note: 'Plugged in.' } });
  const dismissed = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/dismiss` });
  assert.equal(dismissed.statusCode, 200);

  const row = system.store.getHumanTask(humanTask.id)!;
  assert.ok(row.dismissedAt);
  assert.equal(row.status, 'done');
  assert.equal(row.resolution, 'Plugged in.');
  const state = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal((state.json() as { humanTasks: unknown[] }).humanTasks.length, 1);

  const again = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/dismiss` });
  assert.equal(again.statusCode, 409);
  assert.equal(system.store.getHumanTask(humanTask.id)!.dismissedAt, row.dismissedAt);

  assert.equal((await app.inject({ method: 'POST', url: '/api/human-tasks/nope/dismiss' })).statusCode, 409);
});
