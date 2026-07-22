import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { Store } from '../src/store/store.js';
import { Hub, type ServerEvent } from '../src/server/hub.js';
import type { System } from '../src/system.js';
import type { WebSocket } from 'ws';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- PtySession in legible mode --------------------------------------------

test('legible PtySession emits settled text, not raw TUI bytes', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    legibleTranscript: true,
    transcriptDebounceMs: 5,
  });
  const chunks: string[] = [];
  session.on('output', (d: string) => chunks.push(d));
  session.start();
  backend.last().emit('line one\r\n');
  backend.last().emit('✻ Unravelling… (esc to interrupt)');
  backend.last().emit('\r\x1b[2K✶ Pondering… (esc to interrupt)');
  backend.last().emit('\r\x1b[2Kline two\r\n');
  await tick(30);
  const out = chunks.join('');
  assert.equal(out, 'line one\nline two');
  assert.doesNotMatch(out, /esc to interrupt/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(out, /\x1b/);
});

test('legible PtySession still detects sentinels and strips them from the transcript', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    legibleTranscript: true,
    transcriptDebounceMs: 5,
  });
  const chunks: string[] = [];
  let reason: string | null = null;
  let done = false;
  session.on('output', (d: string) => chunks.push(d));
  session.on('waiting', (r: string) => (reason = r));
  session.on('done', () => (done = true));
  session.start();
  backend.last().emit('working\r\n@@LUBBDUBB_WAITING:Which db?@@\r\n');
  await tick(30);
  assert.equal(reason, 'Which db?');
  backend.last().emit('finished\r\n@@LUBBDUBB_DONE@@\r\n');
  assert.equal(done, true);
  await tick(30);
  const out = chunks.join('');
  assert.doesNotMatch(out, /LUBBDUBB/);
  assert.match(out, /working/);
  assert.match(out, /finished/);
});

test('legible PtySession flushes the final settled text before reporting exit', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    legibleTranscript: true,
    transcriptDebounceMs: 5_000, // debounce far in the future: only the exit flush can deliver
  });
  const chunks: string[] = [];
  const order: string[] = [];
  session.on('output', (d: string) => {
    chunks.push(d);
    order.push('output');
  });
  session.on('exit', () => order.push('exit'));
  session.start();
  backend.last().emit('tail content\r\n');
  backend.last().emitExit(0);
  await tick(30);
  assert.equal(chunks.join(''), 'tail content');
  assert.deepEqual(order, ['output', 'exit']);
  assert.equal(session.status, 'done');
});

test('a non-append redraw surfaces as a transcript replace event', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    legibleTranscript: true,
    transcriptDebounceMs: 5,
  });
  const replaces: string[] = [];
  session.on('transcript', (text: string) => replaces.push(text));
  session.start();
  backend.last().emit('one\r\ntwo\r\n');
  await tick(30);
  backend.last().emit('\x1b[2A\x1b[2KONE\r\n\r\n');
  await tick(30);
  assert.deepEqual(replaces, ['ONE\ntwo']);
});

test('non-legible PtySession still emits raw deltas (mock agents, raw mode)', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const chunks: string[] = [];
  session.on('output', (d: string) => chunks.push(d));
  session.start();
  backend.last().emit('raw \x1b[36mbytes\x1b[0m');
  assert.deepEqual(chunks, ['raw \x1b[36mbytes\x1b[0m']);
});

// -- Store.setTranscript ---------------------------------------------------

test('setTranscript replaces the persisted transcript wholesale', () => {
  const store = new Store(':memory:');
  const agentId = 'agent_replace';
  store.appendTranscript(agentId, 'old ');
  store.appendTranscript(agentId, 'content');
  store.flushTranscript(agentId);
  store.setTranscript(agentId, 'fresh settled text');
  assert.equal(store.getTranscript(agentId), 'fresh settled text');
  // Appends after a replace extend the replaced text.
  store.appendTranscript(agentId, '\nmore');
  assert.equal(store.getTranscript(agentId), 'fresh settled text\nmore');
  store.close();
});

// -- Hub fan-out of transcript replaces ------------------------------------

function fakeSystem(): { system: System; agents: EventEmitter } {
  const agents = new EventEmitter();
  const system = {
    harness: new EventEmitter(),
    agents,
    escalations: new EventEmitter(),
    errors: new EventEmitter(),
  } as unknown as System;
  return { system, agents };
}

function fakeSocket(): { socket: WebSocket; sent: ServerEvent[] } {
  const sent: ServerEvent[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerEvent),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, sent };
}

test('hub sends transcript replaces to subscribers and refreshes the tail for everyone', () => {
  const { system, agents } = fakeSystem();
  const hub = new Hub(system);
  const sub = fakeSocket();
  const other = fakeSocket();
  hub.add(sub.socket);
  hub.add(other.socket);
  hub.handleClientMessage(sub.socket, JSON.stringify({ type: 'subscribe', agentId: 'a1' }));

  agents.emit('transcript', { agentId: 'a1', text: 'first line\nsecond line' });

  const replace = sub.sent.find((e) => e.type === 'agent:transcript');
  assert.ok(replace, 'subscribed socket receives the transcript replace');
  assert.equal(replace.type === 'agent:transcript' && replace.text, 'first line\nsecond line');
  assert.equal(
    other.sent.filter((e) => e.type === 'agent:transcript').length,
    0,
    'unsubscribed sockets are spared the full transcript',
  );
  const tailOther = other.sent.find((e) => e.type === 'agent:tail');
  assert.ok(tailOther, 'everyone gets the compact tail');
  assert.equal(tailOther.type === 'agent:tail' && tailOther.line, 'second line');

  // A later delta appends onto the replaced tail state, not the pre-replace one.
  agents.emit('output', { agentId: 'a1', delta: '\nthird line' });
  const tails = other.sent.filter((e) => e.type === 'agent:tail');
  const lastTail = tails[tails.length - 1];
  assert.equal(lastTail && lastTail.type === 'agent:tail' && lastTail.line, 'third line');
});
