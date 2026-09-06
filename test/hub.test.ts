import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Hub, type ServerEvent } from '../src/server/hub.js';
import type { System } from '../src/system.js';
import type { WebSocket } from 'ws';

const OPEN = 1;

function fakeSystem(): {
  system: System;
  agents: EventEmitter;
  localRun: EventEmitter;
  localRunWatch: EventEmitter;
  errors: EventEmitter;
  readying: EventEmitter;
} {
  const agents = new EventEmitter();
  const localRun = new EventEmitter();
  const localRunWatch = new EventEmitter();
  const errors = new EventEmitter();
  const readying = new EventEmitter();
  const system = {
    harness: new EventEmitter(),
    agents,
    escalations: new EventEmitter(),
    errors,
    localRun,
    localRunWatch,
    readying,
    reviewPacks: new EventEmitter(),
    reviewPackChecker: new EventEmitter(),
    localValidations: new EventEmitter(),
  } as unknown as System;
  return { system, agents, localRun, localRunWatch, errors, readying };
}

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

  hub.handleClientMessage(socket, JSON.stringify({ type: 'subscribe', agentId }));
  sent.length = 0;
  agents.emit('output', { agentId, delta: 'more text' });
  const out = sent.find((e) => e.type === 'agent:output');
  assert.ok(out, 'subscribed socket should receive agent:output');
  assert.equal(out.type === 'agent:output' && out.delta, 'more text');

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

  agents.emit('output', { agentId, delta: 'first line\nsecond ' });
  agents.emit('output', { agentId, delta: 'half\n' });
  const tails = sent.filter((e): e is Extract<ServerEvent, { type: 'agent:tail' }> => e.type === 'agent:tail');
  assert.equal(tails.at(-1)!.line, 'second half');

  sent.length = 0;
  agents.emit('output', { agentId, delta: '\n' });
  const afterBlank = sent.filter((e) => e.type === 'agent:tail');
  assert.ok(afterBlank.length > 0, 'tail should still broadcast the retained last line');

  sent.length = 0;
  agents.emit('output', { agentId, delta: 'x'.repeat(500) + '\n' });
  const long = sent.filter((e): e is Extract<ServerEvent, { type: 'agent:tail' }> => e.type === 'agent:tail').at(-1)!;
  assert.equal(long.line.length, 200);
});

test('agent:tail strips ANSI escape codes so the fleet-card preview stays clean', () => {
  const { system, agents } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);
  const agentId = 'agent_ansi';

  agents.emit('output', { agentId, delta: '\x1b[36m⚙ Bash\x1b[0m npm run check\n' });
  const tail = sent.filter((e): e is Extract<ServerEvent, { type: 'agent:tail' }> => e.type === 'agent:tail').at(-1)!;
  assert.ok(!tail.line.includes('\x1b['), 'no raw escape sequences in the preview line');
  assert.ok(tail.line.includes('⚙ Bash'), 'keeps the visible label text');
  assert.ok(tail.line.includes('npm run check'));
});

test('the local run gets one coalesced refetch, however much it says', async () => {
  const { system, localRun } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);

  for (let i = 0; i < 50; i++) localRun.emit('changed');
  assert.deepEqual(sent, [], 'nothing goes out while the window is open');

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(sent, [{ type: 'dirty', sections: ['harness'] }]);
});

test('the watch’s readings ride the local run’s coalescer, not a second one', async () => {
  const { system, localRun, localRunWatch } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);

  for (let i = 0; i < 50; i++) localRun.emit('changed');
  for (let i = 0; i < 50; i++) localRunWatch.emit('changed');
  assert.deepEqual(sent, []);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(sent, [{ type: 'dirty', sections: ['harness'] }]);
});

test('a dirty is scoped only where the signal provably touches one section', () => {
  const { system, agents, errors, readying } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);

  const dirtyFor = (emit: () => void): (readonly string[] | undefined)[] => {
    sent.length = 0;
    emit();
    return sent.filter((e): e is Extract<ServerEvent, { type: 'dirty' }> => e.type === 'dirty').map((e) => e.sections);
  };

  assert.deepEqual(
    dirtyFor(() => agents.emit('files', {})),
    [['fleet']],
  );
  assert.deepEqual(
    dirtyFor(() => agents.emit('usage', {})),
    [['fleet']],
  );
  assert.deepEqual(
    dirtyFor(() => agents.emit('progress', {})),
    [['fleet']],
  );
  assert.deepEqual(
    dirtyFor(() => readying.emit('changed')),
    [['fleet']],
  );
  assert.deepEqual(
    dirtyFor(() => agents.emit('conclusion', {})),
    [['goals']],
  );
  assert.deepEqual(
    dirtyFor(() => agents.emit('retrospective', {})),
    [['goals']],
  );
  assert.deepEqual(
    dirtyFor(() => errors.emit('logged', { message: 'x' })),
    [['activity']],
  );

  assert.deepEqual(
    dirtyFor(() => agents.emit('done', { agentId: 'a', taskId: 't', status: 'done' })),
    [undefined],
  );
  assert.deepEqual(
    dirtyFor(() => agents.emit('status', { agentId: 'a', taskId: 't', status: 'running' })),
    [undefined],
  );
});

test('malformed and unknown client frames are ignored', () => {
  const { system, agents } = fakeSystem();
  const hub = new Hub(system);
  const { socket, sent } = fakeSocket();
  hub.add(socket);
  const agentId = 'agent_3';

  hub.handleClientMessage(socket, 'not json');
  hub.handleClientMessage(socket, JSON.stringify({ type: 'subscribe' }));
  hub.handleClientMessage(socket, JSON.stringify({ type: 'bogus', agentId }));

  agents.emit('output', { agentId, delta: 'data' });
  assert.equal(sent.filter((e) => e.type === 'agent:output').length, 0, 'no subscription should have been recorded');
});
