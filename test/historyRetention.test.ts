import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { HistoryRetentionDesk } from '../src/retention/historyRetention.js';
import { ErrorLog } from '../src/errorLog.js';
import { buildSystem } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { DAY_MS } from '../src/primitives.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function clockedStore(path = ':memory:'): { store: Store; set(ms: number): void } {
  let at = START;
  const store = new Store(path, () => new Date(at).toISOString());
  return { store, set: (ms) => (at = ms) };
}

function desk(store: Store, days = 90, opts: { batchRows?: number; at?: number } = {}): HistoryRetentionDesk {
  return new HistoryRetentionDesk({
    store,
    retentionDays: days,
    errors: new ErrorLog(store),
    now: () => opts.at ?? START + 100 * DAY_MS,
    batchRows: opts.batchRows,
  });
}

function finished(store: Store, status: 'done' | 'failed' = 'done', text = 'output') {
  const task = store.tasks.createTask({
    kind: 'code',
    title: 't',
    prompt: 'a long brief',
    branch: null,
    originRef: null,
  });
  const agent = store.agents.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  store.tasks.updateTask(task.id, { status, agentId: agent.id });
  store.transcripts.appendTranscript(agent.id, text);
  store.transcripts.flushTranscript(agent.id);
  store.agents.updateAgent(agent.id, { status, endedAt: store.tasks.getTask(task.id)!.updatedAt });
  return { task, agent };
}

function decide(store: Store): void {
  store.decisions.recordDecision({
    cycleId: 'cyc',
    action: { type: 'no_op', reason: 'idle' },
    outcome: 'skipped',
    detail: '',
  });
}

test('old finished history goes: transcripts, decisions and task prompts — the task and agent rows stay', async () => {
  const { store } = clockedStore();
  const { task, agent } = finished(store);
  decide(store);

  const sweep = await desk(store).sweep();

  assert.equal(store.transcripts.getTranscript(agent.id), '', 'the transcript is gone');
  assert.equal(store.decisions.listDecisions().length, 0, 'the decision is gone');
  assert.equal(store.tasks.getTask(task.id)?.prompt, '', 'the prompt is compacted');
  assert.equal(store.tasks.getTask(task.id)?.status, 'done', 'the task row is kept');
  assert.ok(store.agents.getAgent(agent.id), 'the agent row is kept');
  assert.deepEqual(
    { transcriptChunks: sweep.transcriptChunks, decisions: sweep.decisions, taskPrompts: sweep.taskPrompts },
    { transcriptChunks: 1, decisions: 1, taskPrompts: 1 },
  );
  store.close();
});

test('the error log ages out with the rest: an old entry goes, a recent one stays', async () => {
  const { store, set } = clockedStore();
  store.errors.recordError({ source: 'cycle', message: 'old' });
  set(START + 50 * DAY_MS);
  store.errors.recordError({ source: 'cycle', message: 'recent' });

  const sweep = await desk(store).sweep();

  assert.deepEqual(
    store.errors.listErrors().map((e) => e.message),
    ['recent'],
  );
  assert.equal(sweep.errors, 1);
  store.close();
});

test('recent history, live work and anything a person may still open are kept', async () => {
  const { store, set } = clockedStore();
  const active = store.tasks.createTask({
    kind: 'code',
    title: 'a',
    prompt: 'live brief',
    branch: null,
    originRef: null,
  });
  const live = store.agents.createAgent({ taskId: active.id, cwd: '/tmp', pid: 1, status: 'running' });
  store.tasks.updateTask(active.id, { status: 'running', agentId: live.id });
  store.transcripts.appendTranscript(live.id, 'live output');
  store.transcripts.flushTranscript(live.id);

  const crashed = store.tasks.createTask({
    kind: 'code',
    title: 'c',
    prompt: 'crashed brief',
    branch: null,
    originRef: null,
  });
  const dead = store.agents.createAgent({ taskId: crashed.id, cwd: '/tmp', pid: null });
  store.tasks.updateTask(crashed.id, { status: 'running', agentId: dead.id });
  store.agents.updateAgent(dead.id, { status: 'crashed', endedAt: new Date(START).toISOString() });
  store.transcripts.appendTranscript(dead.id, 'crashed output');
  store.transcripts.flushTranscript(dead.id);

  const ejected = finished(store, 'done', 'ejected output');
  store.ejections.recordEjection({
    originRef: 'issue:7',
    branch: null,
    worktreePath: null,
    agentId: ejected.agent.id,
    taskId: ejected.task.id,
    sessionId: null,
    reason: 'taking it over',
  });

  const asked = finished(store, 'failed', 'asked output');
  store.escalations.createEscalation({
    type: 'answer_question',
    prompt: 'which?',
    context: {},
    agentId: asked.agent.id,
    taskId: asked.task.id,
  });

  set(START + 50 * DAY_MS);
  const recent = finished(store, 'done', 'recent output');
  decide(store);

  await desk(store).sweep();

  assert.equal(store.transcripts.getTranscript(live.id), 'live output', 'a live agent');
  assert.equal(store.tasks.getTask(active.id)?.prompt, 'live brief', 'an active task');
  assert.equal(store.transcripts.getTranscript(dead.id), 'crashed output', 'a crash still awaiting recovery');
  assert.equal(store.tasks.getTask(crashed.id)?.prompt, 'crashed brief', 'the brief a requeue would quote');
  assert.equal(store.transcripts.getTranscript(ejected.agent.id), 'ejected output', 'an unsettled ejection');
  assert.equal(store.tasks.getTask(ejected.task.id)?.prompt, 'a long brief', 'the brief an ejection hands over');
  assert.equal(store.transcripts.getTranscript(asked.agent.id), 'asked output', 'an agent with an open escalation');
  assert.equal(store.transcripts.getTranscript(recent.agent.id), 'recent output', 'inside the window');
  assert.equal(store.tasks.getTask(recent.task.id)?.prompt, 'a long brief', 'inside the window');
  assert.equal(store.decisions.listDecisions().length, 1, 'a decision inside the window');
  store.close();
});

test('the sweep works in batches until nothing old is left', async () => {
  const { store } = clockedStore();
  for (let i = 0; i < 5; i++) decide(store);
  const { agent } = finished(store);
  for (let i = 0; i < 4; i++) {
    store.transcripts.appendTranscript(agent.id, `chunk ${String(i)}`);
    store.transcripts.flushTranscript(agent.id);
  }
  for (let i = 0; i < 2; i++) finished(store);

  const sweep = await desk(store, 90, { batchRows: 2 }).sweep();

  assert.equal(sweep.decisions, 5);
  assert.equal(sweep.transcriptChunks, 7);
  assert.equal(sweep.taskPrompts, 3);
  assert.equal(sweep.batches, 3 + 4 + 2, 'two rows a batch: three for decisions, four for chunks, two for prompts');
  assert.equal(store.decisions.listDecisions().length, 0);
  store.close();
});

test('0 keeps everything, and the pulse entry does nothing', async () => {
  const { store } = clockedStore();
  const { task, agent } = finished(store);
  decide(store);
  const off = desk(store, 0);

  assert.equal(off.enabled, false);
  off.run();
  const sweep = await off.sweep();

  assert.equal(sweep.batches, 0);
  assert.equal(store.transcripts.getTranscript(agent.id), 'output');
  assert.equal(store.tasks.getTask(task.id)?.prompt, 'a long brief');
  assert.equal(store.decisions.listDecisions().length, 1);
  store.close();
});

test('the pulse entry sweeps at most once a day', async () => {
  const { store } = clockedStore();
  let at = START + 100 * DAY_MS;
  const daily = new HistoryRetentionDesk({ store, retentionDays: 90, errors: new ErrorLog(store), now: () => at });
  decide(store);
  daily.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.decisions.listDecisions().length, 0, 'the first pulse sweeps');

  decide(store);
  at += DAY_MS / 2;
  daily.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.decisions.listDecisions().length, 1, 'half a day later it does not');

  at += DAY_MS;
  daily.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.decisions.listDecisions().length, 0, 'a day later it does');
  store.close();
});

test('a new database is incremental, so the freed pages go back to the disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-retention-'));
  try {
    const { store } = clockedStore(join(dir, 'store.db'));
    for (let i = 0; i < 20; i++) finished(store, 'done', 'x'.repeat(20_000));
    const sweep = await desk(store).sweep();
    assert.equal(sweep.transcriptChunks, 20);
    assert.equal(sweep.freePagesLeft, 0, 'every page the deletes freed was handed back');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSystem wires the sweep off historyRetentionDays, ninety days by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-retention-'));
  const base = {
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw' as const,
    repoRoot: dir,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  };
  const opts = () => ({ worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const system = buildSystem(loadConfig(base), opts());
  assert.equal(system.config.historyRetentionDays, 90);
  assert.equal(system.retention.enabled, true);
  system.store.close();

  const off = buildSystem(loadConfig({ ...base, historyRetentionDays: 0 }), opts());
  assert.equal(off.retention.enabled, false);
  off.store.close();
});
