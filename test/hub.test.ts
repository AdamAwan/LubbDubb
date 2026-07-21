import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Hub, type ServerEvent } from '../src/server/hub.js';
import type { System } from '../src/system.js';
import type { WebSocket } from 'ws';

const OPEN = 1;

/** Minimal System: Hub only wires `.on` handlers on these three emitters. */
function fakeSystem(): { system: System; agents: EventEmitter } {
  const agents = new EventEmitter();
  const system = {
    harness: new EventEmitter(),
    agents,
    escalations: new EventEmitter(),
  } as unknown as System;
  return { system, agents };
}

/** Fake ws socket that captures everything sent to it. */
function fakeSocket(): { socket: WebSocket; sent: ServerEvent[] } {
  const sent: ServerEvent[] = [];
  const socket = {
    OPEN,
    readyState: OPEN,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerEvent),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, sent };
}

test('unsubscribed socket gets agent:tail but not agent:output; subscribing unlocks output', () => {
  const { system, agents } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);

  const agentId = 'agent_1';

  // Before subscribing: only the compact tail reaches the socket.
  agents.emit('output', { agentId, delta: 'hello world\n' });
  assert.equal(
    sent.filter((e) => e.type === 'agent:output').length,
    0,
    'unsubscribed socket must not receive agent:output',
  );
  const tail = sent.find((e) => e.type === 'agent:tail');
  assert.ok(tail, 'unsubscribed socket should receive agent:tail');
  assert.equal(tail.type === 'agent:tail' && tail.line, 'hello world');
  assert.equal(tail.type === 'agent:tail' && tail.agentId, agentId);

  // After subscribing: the full output frame is delivered.
  hub.handleClientMessage(socket, JSON.stringify({ type: 'subscribe', agentId }));
  sent.length = 0;
  agents.emit('output', { agentId, delta: 'more text' });
  const out = sent.find((e) => e.type === 'agent:output');
  assert.ok(out, 'subscribed socket should receive agent:output');
  assert.equal(out.type === 'agent:output' && out.delta, 'more text');

  // Unsubscribing stops the full frames again.
  hub.handleClientMessage(socket, JSON.stringify({ type: 'unsubscribe', agentId }));
  sent.length = 0;
  agents.emit('output', { agentId, delta: 'silent\n' });
  assert.equal(sent.filter((e) => e.type === 'agent:output').length, 0, 'unsubscribe should stop output frames');
});

test('agent:tail carries the last non-empty line across delta boundaries and caps at 200 chars', () => {
  const { system, agents } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);
  const agentId = 'agent_2';

  // A line split across two deltas resolves to the full joined line.
  agents.emit('output', { agentId, delta: 'first line\nsecond ' });
  agents.emit('output', { agentId, delta: 'half\n' });
  const tails = sent.filter((e): e is Extract<ServerEvent, { type: 'agent:tail' }> => e.type === 'agent:tail');
  assert.equal(tails.at(-1)!.line, 'second half');

  // A whitespace-only delta keeps the last known good line rather than blanking.
  sent.length = 0;
  agents.emit('output', { agentId, delta: '\n' });
  const afterBlank = sent.filter((e) => e.type === 'agent:tail');
  assert.ok(afterBlank.length > 0, 'tail should still broadcast the retained last line');

  // Cap at 200 chars.
  sent.length = 0;
  agents.emit('output', { agentId, delta: 'x'.repeat(500) + '\n' });
  const long = sent.filter((e): e is Extract<ServerEvent, { type: 'agent:tail' }> => e.type === 'agent:tail').at(-1)!;
  assert.equal(long.line.length, 200);
});

test('malformed and unknown client frames are ignored', () => {
  const { system, agents } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);
  const agentId = 'agent_3';

  hub.handleClientMessage(socket, 'not json');
  hub.handleClientMessage(socket, JSON.stringify({ type: 'subscribe' })); // missing agentId
  hub.handleClientMessage(socket, JSON.stringify({ type: 'bogus', agentId }));

  agents.emit('output', { agentId, delta: 'data' });
  assert.equal(sent.filter((e) => e.type === 'agent:output').length, 0, 'no subscription should have been recorded');
});
