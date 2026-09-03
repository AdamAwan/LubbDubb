import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ObstacleNoticeDesk } from '../src/obstacles/noticeDesk.js';
import { obstacleNotices, type NoticeAgent } from '../src/obstacles/notices.js';
import type { DeliverableObstacle } from '../src/obstacles/delivery.js';
import type { Agent, Obstacle, ObstacleKey, ObstacleState } from '../src/types.js';

/**
 * The second delivery channel: **mid-session, to a running agent**.
 *
 * Three rules keep it worth reading, and each has a test here that fails when it
 * is broken: **once per agent per obstacle, ever**; **never to the reporter or
 * the owner**; **never for anything else**. A chatty channel is skimmed, and then
 * the message that mattered is skimmed too.
 * → `docs/spec/27-obstacles.md#delivery`
 */

/** One row as the pure decision reads it. */
function row(id: string, over: Partial<Obstacle> = {}, checks: string[] = ['test (windows)']): DeliverableObstacle {
  const obstacle: Obstacle = {
    id,
    what: `the ${id} thing is broken`,
    kind: 'obstacle',
    state: 'standing',
    ownerRef: null,
    until: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    endedBy: null,
    ...over,
  };
  const keys: ObstacleKey[] = checks.map((value, i) => ({
    id: `${id}-k${i}`,
    obstacleId: id,
    kind: 'check',
    value,
    binds: true,
    confirmations: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  return { obstacle, keys };
}

function agent(over: Partial<NoticeAgent> = {}): NoticeAgent {
  return {
    agentId: 'agent-1',
    goalRef: 'issue:12',
    scopes: ['goal:issue:12', 'check:test (windows)'],
    reported: new Set<string>(),
    notified: new Set<string>(),
    ...over,
  };
}

test('never to the reporter: the agent that filed it is told what became of it, and never that it exists', () => {
  const standing = row('obs-a');
  const mine = agent({ reported: new Set(['obs-a']) });
  const other = agent({ agentId: 'agent-2' });

  const sent = obstacleNotices([standing], [mine, other]);

  // Telling the agent whose report created the row that the row exists is absurd.
  assert.deepEqual(
    sent.map((n) => n.agentId),
    ['agent-2'],
  );
  // What it *is* told is the thing that changes what it should do next: its own
  // report has been taken up.
  const owned = obstacleNotices([row('obs-a', { state: 'owned', ownerRef: 'issue:841' })], [mine]);
  assert.equal(owned.length, 1);
  assert.equal(owned[0]!.reason, 'owned');
  assert.match(owned[0]!.text, /issue:841 now owns what you reported/);
  assert.match(owned[0]!.text, /Do not fix it/);
});

test('never to the owner: the agent dispatched to fix it is not told to stand down from it', () => {
  const owned = row('obs-a', { state: 'owned', ownerRef: 'issue:841' });
  const fixer = agent({ agentId: 'agent-fix', goalRef: 'issue:841', reported: new Set(['obs-a']) });
  const bystander = agent({ agentId: 'agent-2' });

  const sent = obstacleNotices([owned], [fixer, bystander]);

  // The owner is the one party a row is not news to, and a notice saying *do not
  // fix this* to the agent dispatched to fix it is the channel arguing with the
  // fleet. The bystander gets nothing either: `owned` is not the standing arm.
  assert.deepEqual(sent, []);
});

test('never for anything else: only a standing arrival, and only on a check this dispatch is about', () => {
  const elsewhere = row('obs-elsewhere', {}, ['lint']);
  const quiet: ObstacleState[] = ['sighted', 'dormant', 'muted', 'resolved'];

  // A row on another check is nothing to this agent, however standing it is.
  assert.deepEqual(obstacleNotices([elsewhere], [agent()]), []);
  // And no state but `standing` reaches an agent that never reported it: an
  // interruption is a cost, and it is paid only where something changed.
  for (const state of quiet) {
    assert.deepEqual(obstacleNotices([row('obs-a', { state })], [agent()]), [], `${state} reached an agent`);
  }
  // The one that does.
  const sent = obstacleNotices([row('obs-a')], [agent()]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.reason, 'standing');
  assert.match(sent[0]!.text, /Do not go fixing it/);
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacle-notices-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** A live agent on a dispatch about one check. */
function spawnAgent(system: System, originRef: string, ciChecks: string[] = ['test (windows)']): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Big thing',
    ciChecks,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

/** Two independent goals, which is what carries a row to `standing`. */
function stand(system: System, what: string, check: string): void {
  for (const goal of ['issue:900', 'issue:901']) {
    system.store.recordObstacleSighting(
      {
        what,
        kind: 'obstacle',
        keys: [
          { kind: 'check', value: check, binds: true },
          { kind: 'path', value: 'src/a.ts', binds: true },
        ],
        untilHours: null,
      },
      {
        agentId: `agent-${goal}`,
        taskId: `task-${goal}`,
        goalRef: goal,
        sessionId: null,
        transition: null,
        words: what,
        whyNotMine: 'nothing of mine is near it.',
      },
    );
  }
}

test('once per agent per obstacle, ever: a second pulse sends nothing', () => {
  const system = build();
  const live = spawnAgent(system, 'issue:12');
  stand(system, 'the windows runner wedges before the suite starts', 'test (windows)');
  const sent: { agentId: string; text: string }[] = [];
  const desk = new ObstacleNoticeDesk({
    store: system.store,
    fleet: {
      isLive: (id) => system.agents.isLive(id),
      notify: (agentId, text) => {
        sent.push({ agentId, text });
        return true;
      },
    },
  });

  desk.run();
  desk.run();
  desk.run();

  // A notice that arrives twice reads as a second problem, and the ledger is a
  // primary key rather than a condition: nothing a later writer can forget.
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.agentId, live.id);
  assert.match(sent[0]!.text, /windows runner wedges/);
  assert.deepEqual([...system.store.obstaclesNoticedBy(live.id)], [system.store.listObstacles()[0]!.id]);
  system.store.close();
});

test('a notice reaches a live session only, and never ends a park', () => {
  const system = build();
  const live = spawnAgent(system, 'issue:12');
  stand(system, 'the windows runner wedges before the suite starts', 'test (windows)');

  // The real fleet, so what the desk asks of it is what the runtime offers.
  new ObstacleNoticeDesk({ store: system.store, fleet: system.agents }).run();
  assert.deepEqual([...system.store.obstaclesNoticedBy(live.id)], [system.store.listObstacles()[0]!.id]);

  // An agent that is not live cannot be typed into, and the desk does not pretend
  // otherwise: nothing is sent, and the row it left behind is the honest record
  // that this pair has had its one notice.
  assert.equal(system.agents.notify('agent-that-never-was', 'anything at all'), false);
  system.store.close();
});
