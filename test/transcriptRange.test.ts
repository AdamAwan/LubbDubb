import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { AgentTranscript } from '../src/wire.js';

/**
 * `GET /api/agents/:id/transcript?from=` — the range the agent drawer's poll
 * needs (issue #639).
 *
 * The drawer re-reads the transcript every five seconds while a run is live,
 * because the socket only carries what an agent produced since the drawer
 * subscribed and so can never fill in the part before it. Re-fetching the whole
 * record per poll would ship megabytes of unchanged text per open drawer, so the
 * poll names what it holds and is answered with the tail.
 */

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  return buildSystem(config, { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager() });
}

/** An agent row with `chunks` appended to its transcript, and the app to read it through. */
async function withTranscript(chunks: string[]) {
  const system = build();
  const { app } = await buildApp(system);
  const task = system.store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = system.store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  for (const c of chunks) system.store.appendTranscript(agent.id, c);
  const read = async (from?: number): Promise<AgentTranscript> => {
    const url = `/api/agents/${agent.id}/transcript${from === undefined ? '' : `?from=${from}`}`;
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as AgentTranscript;
  };
  return { system, app, agent, read };
}

test('a bare read answers with the whole transcript, and says how long it is', async () => {
  const { system, app, agent, read } = await withTranscript(['hello ', 'world']);

  const all = await read();
  assert.deepEqual(all, { agentId: agent.id, from: 0, total: 11, transcript: 'hello world' });

  await app.close();
  system.store.close();
});

test('a ranged read answers with only the tail past what the caller holds', async () => {
  const { system, app, read } = await withTranscript(['hello ', 'world']);

  const tail = await read(6);
  assert.equal(tail.from, 6);
  assert.equal(tail.total, 11);
  assert.equal(tail.transcript, 'world', 'the poll must not re-ship what the drawer already drew');

  await app.close();
  system.store.close();
});

test('a poll on a run that has printed nothing new costs an empty string, not the record', async () => {
  const { system, app, read } = await withTranscript(['a'.repeat(5000)]);

  const quiet = await read(5000);
  assert.equal(quiet.transcript, '');
  assert.equal(quiet.total, 5000, 'the length is still reported, so the drawer knows it is up to date');

  await app.close();
  system.store.close();
});

test('an offset past the end is clamped rather than refused', async () => {
  // A transcript only grows, so this is a client that read across a flush — it
  // wants to be told where the end is, not handed a 400 it can do nothing with.
  const { system, app, read } = await withTranscript(['short']);

  const over = await read(9999);
  assert.equal(over.from, 5, 'from comes back clamped to the record it is being read against');
  assert.equal(over.total, 5);
  assert.equal(over.transcript, '');

  await app.close();
  system.store.close();
});

test('successive ranged reads reassemble exactly the whole transcript', async () => {
  // What the drawer actually does: seed, then append each tail onto it. The
  // concatenation must equal the record, or the pane draws output with a hole in it.
  const chunks = Array.from({ length: 40 }, (_, i) => `line ${i}\n`);
  const { system, app, read } = await withTranscript([]);

  let held = 0;
  let built = '';
  const whole: string[] = [];
  for (const c of chunks) {
    system.store.appendTranscript(system.store.listAgents()[0]!.id, c);
    whole.push(c);
    const r = await read(held);
    assert.equal(r.from, held, 'a growing transcript never moves the offset the caller named');
    built += r.transcript;
    held = r.total;
  }
  assert.equal(built, whole.join(''));

  await app.close();
  system.store.close();
});

test('a malformed range is refused by name rather than silently read as zero', async () => {
  const { system, app, agent } = await withTranscript(['x']);

  for (const [from, word] of [
    ['-1', 'negative'],
    ['1.5', 'whole'],
    ['banana', 'number'],
  ] as const) {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/transcript?from=${from}` });
    assert.equal(res.statusCode, 400, `from=${from} must be refused`);
    assert.match((JSON.parse(res.body) as { error: string }).error, new RegExp(word));
  }

  await app.close();
  system.store.close();
});

test('an unknown agent is still a 404, range or no range', async () => {
  const system = build();
  const { app } = await buildApp(system);

  assert.equal((await app.inject({ method: 'GET', url: '/api/agents/nope/transcript' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/agents/nope/transcript?from=5' })).statusCode, 404);

  await app.close();
  system.store.close();
});
