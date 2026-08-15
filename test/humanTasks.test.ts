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

/**
 * Work only a person can do.
 *
 * The property worth holding on to while reading these: a human task is **work,
 * not an alert**. Nothing is blocked on a socket, no agent is parked, the row
 * outlives every agent and every restart — and the one thing that can hold the
 * fleet off is a plan part the task backs, never the task itself. So the suite
 * asks three separate questions: does the row survive, does an agent's request
 * reach it, and does a step for a person actually stop the parts that named it.
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-human-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 5,
    planning: { ...DEFAULT_PLANNING, requireApproval: false },
    ...overrides,
  });
}

/**
 * A whole system with the fakes injected. `worktrees` is not optional: without it
 * `config.repoRoot` defaults to `process.cwd()` and a dispatched code agent cuts a
 * real branch in whatever checkout the suite is running in.
 */
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

/** An agent on an ordinary pickup, the way one reaching for the tool would be. */
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

// -- the pure half ------------------------------------------------------------

test('a one-line title is the boundary, and the refusal names where the rest goes', () => {
  const ok = validateHumanTask({ title: '  Enable the staging webhook  ', detail: '  Dashboard → Developers  ' });
  assert.ok(ok.ok);
  // Trimmed on both fields, so a model's stray indentation is not the operator's
  // problem to read around.
  assert.deepEqual(ok.input, { title: 'Enable the staging webhook', detail: 'Dashboard → Developers' });

  // The load-bearing refusal: the only cheap moment to fix a blob is the agent's
  // own turn, and the error has to say which field the rest belongs in or the same
  // paragraph comes back shortened.
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

  // Optional on purpose: a required field an agent has nothing for comes back as
  // "N/A", and a list of those is worse than a bare title.
  const bare = validateHumanTask({ title: 'Plug the reader into the test rig' });
  assert.ok(bare.ok);
  assert.equal(bare.input.detail, null);
});

// -- the entity ---------------------------------------------------------------

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

  // The whole point of a durable entity over an escalation: the process went away
  // and the obligation did not.
  const second = new Store(dbPath);
  const reopened = second.listHumanTasks();
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]!.title, 'Rotate the CI deploy key');
  assert.equal(reopened[0]!.status, 'open');

  const settled = second.settleHumanTask(task.id, 'done', 'Rotated and redeployed.');
  assert.equal(settled?.status, 'done');
  assert.equal(settled?.resolution, 'Rotated and redeployed.');
  assert.ok(settled?.resolvedAt);
  // Compare-and-set in the write: a second click settles nothing, so it cannot
  // overwrite the first verdict with the second.
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
  // Better instructions overwrite the thinner ones: the title is the claim, the
  // detail is its supporting text.
  assert.equal(again.task.detail, 'thicker, with the URL');
  assert.equal(system.store.listHumanTasks().length, 1);

  // Declined, then asked for again: still declined, which is what declining meant.
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

// -- the agent's request path -------------------------------------------------

test('request_human_task is advertised, and identity is structural', async () => {
  const system = build();
  assert.ok(MCP_TOOL_NAMES.includes('request_human_task'));

  const agent = pickupAgent(system);
  const task = system.store.getTask(agent.taskId)!;
  const tool = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find(
    (t) => t.name === 'request_human_task',
  );
  assert.ok(tool, 'the tool is built, so the name and the module agree');
  // No agent, task, issue or origin argument: an agent cannot file an obligation
  // under another agent's name however it phrases the call.
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
  // Said in the response, not only in the description: an agent that believes
  // filing this arranged something will sit waiting for it.
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

// -- what it does to the fleet ------------------------------------------------

test('nothing in the dispatcher reads human tasks — a standalone one blocks nothing', async () => {
  const system = build();
  system.store.setWorldBaseline(world([issue(12)]));
  const agent = pickupAgent(system);
  await callTool(system, agent, 'request_human_task', { title: 'Look at the rendered screen' });

  // The gate that would matter if there were one: an open human task against
  // `issue:12` leaves the issue exactly as dispatchable as it was.
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

  // Ingestion backed it with a row, keyed on the part, with the part's own origin
  // so the panel links it like everything else.
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

  // The operator does it. The part concludes with `human` as its outcome — the
  // record of *what* closed it — and the dependent is released.
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
  // The note is required: a planner shown only "declined" has no reason to decide
  // differently to the way it just decided.
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
  // **Not** concluded. Concluding it would make `partSettled` true and release
  // every dependent waiting on the thing that was refused — a plan completing on
  // work nobody did.
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.blockedReason ?? '', /declined/);
  assert.notEqual(dependent.status, 'ready');

  // Declining is settled once, like every other verdict on this row.
  const again = await app.inject({
    method: 'POST',
    url: `/api/human-tasks/${backing.id}/decline`,
    payload: { note: 'again' },
  });
  assert.equal(again.statusCode, 409);
});

// -- the operator's own arm ---------------------------------------------------

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
  // No agent behind it, which is exactly what a null `agentId` means — there is no
  // `requestedBy` column to disagree with the ids beside it.
  assert.equal(humanTask.agentId, null);

  // The same one-line bound as the tool's, from the same pure function: it is a
  // property of the panel row, not of who typed it.
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
  // Settled ones stay in the list: "we asked and it was declined" is information,
  // and a row that vanished would take the operator's note with it.
  const after = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal((after.json() as { humanTasks: unknown[] }).humanTasks.length, 1);

  assert.equal((await app.inject({ method: 'POST', url: '/api/human-tasks/nope/done' })).statusCode, 409);
});

/**
 * The way a settled row leaves the bench.
 *
 * The close-out sweep files and settles its own rows without anyone touching
 * them, so on a busy repo the record of work nobody did accumulates under the
 * work you have — and until there was a dismissal there was nothing to do about
 * it. What makes it safe is that it is **not a verdict**: an open obligation
 * cannot be dismissed, so this can never be a quiet way to make work go away, and
 * the settled row it hides keeps its status and its note.
 */
test('a settled task is dismissed off the bench; an open one cannot be, and nothing else moves', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const created = await app.inject({
    method: 'POST',
    url: '/api/human-tasks',
    payload: { title: 'Plug the card reader into the test rig' },
  });
  const { humanTask } = created.json() as { humanTask: { id: string } };

  // The guard that makes the button safe: an obligation nobody has answered has
  // two answers, and hiding it is neither.
  const early = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/dismiss` });
  assert.equal(early.statusCode, 409);
  assert.equal(system.store.getHumanTask(humanTask.id)!.dismissedAt, null);

  await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/done`, payload: { note: 'Plugged in.' } });
  const dismissed = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/dismiss` });
  assert.equal(dismissed.statusCode, 200);

  const row = system.store.getHumanTask(humanTask.id)!;
  assert.ok(row.dismissedAt);
  // It answered nothing, so the verdict and the operator's own note are exactly
  // where they were — the row is kept, and the bench is what stops drawing it.
  assert.equal(row.status, 'done');
  assert.equal(row.resolution, 'Plugged in.');
  const state = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal((state.json() as { humanTasks: unknown[] }).humanTasks.length, 1);

  // Compare-and-set on both halves, as every other verdict on this row is: a
  // second click dismisses nothing and cannot restamp the time.
  const again = await app.inject({ method: 'POST', url: `/api/human-tasks/${humanTask.id}/dismiss` });
  assert.equal(again.statusCode, 409);
  assert.equal(system.store.getHumanTask(humanTask.id)!.dismissedAt, row.dismissedAt);

  assert.equal((await app.inject({ method: 'POST', url: '/api/human-tasks/nope/dismiss' })).statusCode, 409);
});
