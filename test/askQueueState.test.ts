import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Hub, type ServerEvent } from '../src/server/hub.js';
import { buildApp } from '../src/server/app.js';
import { askQueue } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import type { CockpitState } from '../src/wire.js';

/* The queue is derived once, on the server, and the cockpit and Claude Code read that one list.
   → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-askqueue-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function seed(system: System): Promise<{ question: string; merge: string; bench: string; proposal: string }> {
  const { escalations, humanTasks } = system.store;
  const bench = humanTasks.recordHumanTask({
    title: 'Provision the staging credentials',
    detail: null,
    agentId: null,
    taskId: null,
    originRef: null,
  }).task;
  await tick();
  const question = escalations.createEscalation({
    type: 'answer_question',
    prompt: 'Which store should this write to?',
    context: {},
    agentId: null,
    taskId: null,
  });
  await tick();
  const merge = escalations.createEscalation({
    type: 'approve_change',
    prompt: 'Merge PR #7?',
    context: { prNumber: 7 },
    agentId: null,
    taskId: null,
  });
  const proposal = escalations.createProposal({
    kind: 'merge',
    ref: 'pr:7',
    action: { type: 'merge_pr', reason: 'green', prNumber: 7 } as never,
    escalationId: merge.id,
  });
  return { question: question.id, merge: merge.id, bench: bench.id, proposal: proposal.id };
}

test('/api/state ships the asks in the rail’s order, each with its place in the one-at-a-time order', async () => {
  const system = build();
  const ids = await seed(system);
  const { app } = await buildApp(system);

  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json<CockpitState>();
  assert.deepEqual(
    state.asks.map((r) => r.id),
    [ids.question, ids.merge, ids.bench],
    'blocking before yours, and within the blocking pair the older first',
  );
  assert.deepEqual(
    [...state.asks].sort((a, b) => a.focusRank - b.focusRank).map((r) => r.id),
    [ids.merge, ids.question, ids.bench],
    'one at a time, the merge leads its tier: it is one press from landing',
  );
  const merge = state.asks.find((r) => r.id === ids.merge);
  assert.equal(merge?.kind, 'merge');
  assert.deepEqual(merge?.subject, { type: 'escalation', escalationId: ids.merge, proposalId: ids.proposal });
  assert.deepEqual(state.asks.find((r) => r.id === ids.bench)?.subject, { type: 'human_task', taskId: ids.bench });

  const alone = (await app.inject({ method: 'GET', url: '/api/state?sections=asks' })).json<CockpitState>();
  assert.deepEqual(alone.asks, state.asks, 'asked for alone, the queue is the one the whole snapshot carries');
  const control = (await app.inject({ method: 'GET', url: '/api/state?sections=control' })).json<CockpitState>();
  assert.equal(control.asks, undefined, 'and a reply that did not ask for it does not pay for it');

  await app.close();
  system.store.close();
});

test('askQueue is the same list, standing rows only, in the order a one-at-a-time reader walks it', async () => {
  const system = build();
  const ids = await seed(system);

  assert.deepEqual(
    askQueue(system).map((r) => r.id),
    [ids.merge, ids.question, ids.bench],
  );

  system.store.escalations.answerEscalation(ids.merge, 'merge it');
  assert.deepEqual(
    askQueue(system).map((r) => r.id),
    [ids.question, ids.bench],
    'an answered ask leaves the queue, which is how a reader tells it was settled',
  );
  system.store.close();
});

test('a dirty that names a section feeding the queue names the queue too, and the frequent fleet ones do not', () => {
  const emitters = ['harness', 'agents', 'escalations', 'errors', 'localRun', 'localRunWatch', 'readying', 'desktop'];
  const fake = Object.fromEntries(emitters.map((name) => [name, new EventEmitter()]));
  const hub = new Hub({
    ...fake,
    localValidations: new EventEmitter(),
    remoteRuns: new EventEmitter(),
  } as unknown as System);
  const sent: ServerEvent[] = [];
  hub.add({ OPEN: 1, readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), on: () => {} } as never);

  hub.broadcast({ type: 'dirty', sections: ['plans'] });
  fake.agents!.emit('progress', {});
  fake.agents!.emit('waiting', { agentId: 'a', taskId: 't', reason: 'limit' });
  fake.escalations!.emit('created', { id: 'e' });

  const dirty = sent.flatMap((e) => (e.type === 'dirty' ? [e.sections] : []));
  assert.deepEqual(dirty, [['plans', 'asks'], ['fleet'], ['fleet', 'asks'], ['inbox', 'asks']]);
});
