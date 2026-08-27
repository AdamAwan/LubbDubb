import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { OVERLAP_AGENT_WINDOW } from '../src/fileOverlap.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * What moved off `/api/state` when the whole-fleet `files` list came off it, and
 * the one thing that must **not** have moved with it.
 *
 * The list was 87% of the snapshot — every file every agent ever wrote, on a table
 * nothing deletes from, built and serialised on every poll so that one open drawer
 * could take one agent's slice. It is a route now, and what stayed behind reads a
 * *window* of agents. The window is the hazard these tests exist for: it is correct
 * for the overlap detector, which can only report concurrency, and silently wrong
 * for anything that judges an old agent's writes.
 */
function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

test('GET /api/agents/:id/files answers one agent, and 404s an agent that does not exist', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const taskA = system.store.createTask({ kind: 'code', title: 'a', prompt: 'p', branch: 'b1', originRef: 'issue:1' });
  const taskB = system.store.createTask({ kind: 'code', title: 'b', prompt: 'p', branch: 'b2', originRef: 'issue:2' });
  const a = system.store.createAgent({ taskId: taskA.id, cwd: '/wt/a', pid: null });
  const b = system.store.createAgent({ taskId: taskB.id, cwd: '/wt/b', pid: null });
  system.store.recordFile(a.id, { path: 'src/wire.ts', tool: 'Write', promoted: false });
  system.store.recordFile(a.id, { path: 'src/system.ts', tool: 'Edit', promoted: false });
  system.store.recordFile(b.id, { path: 'README.md', tool: 'Write', promoted: false });

  const res = await app.inject({ method: 'GET', url: `/api/agents/${a.id}/files` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { agentId: string; files: { path: string }[] };
  assert.equal(body.agentId, a.id);
  // This agent's rows and no one else's: the whole point of the route.
  assert.deepEqual(body.files.map((f) => f.path).sort(), ['src/system.ts', 'src/wire.ts']);

  // An agent that wrote nothing and an agent that does not exist are different
  // answers, exactly as the transcript route holds them apart.
  assert.equal((await app.inject({ method: 'GET', url: '/api/agents/agent_nope/files' })).statusCode, 404);

  system.store.close();
});

test('the state snapshot no longer ships a fleet-wide files list', () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const task = system.store.createTask({ kind: 'code', title: 'a', prompt: 'p', branch: 'b', originRef: 'issue:1' });
  const agent = system.store.createAgent({ taskId: task.id, cwd: '/wt/a', pid: null });
  system.store.recordFile(agent.id, { path: 'src/wire.ts', tool: 'Write', promoted: false });

  const snap: Record<string, unknown> = { ...buildStateSnapshot(system) };
  assert.equal('files' in snap, false, 'the drawer fetches its own rows; nothing polls the whole table');
  // The detector it was shared with is still shipped — it reads its rows
  // server-side now, over a window.
  assert.ok(Array.isArray(snap.overlaps));

  system.store.close();
});

/**
 * The regression the window makes available, and the reason `driftFiles` is a
 * second read rather than the detector's.
 *
 * A plan is judged against the agents that worked *its* parts. On a goal that has
 * been running a fortnight those are nowhere near the newest couple of hundred
 * agent rows — so a drift check sharing the overlap window would report a part as
 * inside its declared scope because the agent that left the mark was too old to be
 * read. The check passing for exactly the reason it should have fired, with
 * nothing red.
 */
test('scope drift still sees a part whose agent is older than the overlap window', () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const store = system.store;

  const plan = store.upsertPlan({
    originRef: 'issue:12',
    title: 'Issue #12',
    status: 'active',
    reason: 'Two pull requests of work.',
  });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'the store',
      touches: ['src/store/'],
      dependsOn: [],
      rationale: null,
      acceptance: null,
      size: null,
      expectedKind: null,
      profile: null,
    },
  ]);

  // The part's agent, written first so every agent below is newer than it.
  const partTask = store.createTask({
    kind: 'code',
    title: 'Schema',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  const partAgent = store.createAgent({ taskId: partTask.id, cwd: '/wt/p', pid: null });
  store.updateTask(partTask.id, { agentId: partAgent.id });
  store.recordFile(partAgent.id, { path: 'src/wire.ts', tool: 'Write', promoted: false });

  // …and then push it clear out of the window with unrelated fleet history.
  for (let i = 0; i < OVERLAP_AGENT_WINDOW + 5; i++) {
    const t = store.createTask({ kind: 'code', title: `t${i}`, prompt: 'p', branch: `b${i}`, originRef: `issue:${i}` });
    const a = store.createAgent({ taskId: t.id, cwd: `/wt/${i}`, pid: null });
    store.updateTask(t.id, { agentId: a.id });
    store.recordFile(a.id, { path: `src/other/${i}.ts`, tool: 'Write', promoted: false });
  }

  const snap = buildStateSnapshot(system);
  const drifted = snap.planParts.find((p) => p.slug === 'schema');
  assert.deepEqual(
    drifted?.outsideScope,
    ['src/wire.ts'],
    'a part is judged against its own agents, however far down the fleet history they are',
  );

  system.store.close();
});
