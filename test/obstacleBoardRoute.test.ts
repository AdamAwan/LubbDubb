import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ObstacleBoardPayload } from '../src/wire.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obboard-'));
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

function say(system: System, what: string, goalRef: string | null, keys: { kind: 'test'; value: string }[]) {
  return system.store.obstacles.recordObstacleSighting(
    { what, kind: 'obstacle', keys: keys.map((key) => ({ ...key, binds: true })), untilHours: null },
    {
      agentId: null,
      taskId: null,
      goalRef,
      sessionId: null,
      transition: null,
      words: `${goalRef ?? 'the harness'} hit ${what}`,
      whyNotMine: 'my diff does not touch it',
    },
  );
}

test('the board ships every row with its voices, and counts only what something counted', async () => {
  const system = build();
  const key = [{ kind: 'test' as const, value: 'test/a.test.ts > flakes' }];
  say(system, 'a.test.ts flakes on windows', 'issue:11', key);
  say(system, 'a.test.ts flakes on windows', 'issue:12', key);
  say(system, 'b.test.ts hangs', 'issue:13', [{ kind: 'test', value: 'test/b.test.ts > hangs' }]);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/obstacles' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as ObstacleBoardPayload;

  assert.equal(body.rows.length, 2, 'two keys, two rows');
  const standing = body.rows.find((row) => row.obstacle.state === 'standing');
  assert.ok(standing, 'two independent goals carry a row to standing');
  assert.equal(standing.sightings.length, 2);
  assert.deepEqual(
    standing.sightings.map((sighting) => sighting.goalRef),
    ['issue:11', 'issue:12'],
  );
  assert.equal(standing.sightings[0]!.matchedBy, 'fresh');
  assert.equal(standing.sightings[1]!.matchedBy, 'test:test/a.test.ts > flakes');

  assert.equal(body.counts.sightings, 3);
  assert.equal(body.counts.goals, 3);
  assert.equal(body.counts.told, 0);
  assert.equal(body.counts.window.calls, 0);
  assert.equal(body.dormantMs, system.config.obstacleDormantMs);

  await app.close();
  system.store.close();
});

test('muting is a person and only a person, and it goes both ways', async () => {
  const system = build();
  const { obstacle } = say(system, 'the base is red', 'issue:11', [{ kind: 'test', value: 'test/c.test.ts > red' }]);
  const { app } = await buildApp(system);

  const muted = await app.inject({
    method: 'POST',
    url: `/api/obstacles/${obstacle.id}/mute`,
    payload: { muted: true },
  });
  assert.equal(muted.statusCode, 200);
  assert.equal(system.store.obstacles.getObstacle(obstacle.id)?.state, 'muted');

  const back = await app.inject({
    method: 'POST',
    url: `/api/obstacles/${obstacle.id}/mute`,
    payload: { muted: false },
  });
  assert.equal(back.statusCode, 200);
  assert.equal(system.store.obstacles.getObstacle(obstacle.id)?.state, 'standing');

  const bare = await app.inject({ method: 'POST', url: `/api/obstacles/${obstacle.id}/mute`, payload: {} });
  assert.equal(bare.statusCode, 400);
  assert.match(String(bare.json().error), /muted/);

  await app.close();
  system.store.close();
});

test('owning takes the row through the same claim the pulse takes, and a second click is refused', async () => {
  const system = build();
  const key = [{ kind: 'test' as const, value: 'test/d.test.ts > wedged' }];
  say(system, 'the runner is wedged', 'issue:11', key);
  const { obstacle } = say(system, 'the runner is wedged', 'issue:12', key);
  const { app } = await buildApp(system);

  const took = await app.inject({
    method: 'POST',
    url: `/api/obstacles/${obstacle.id}/own`,
    payload: { ownerRef: 'issue:412' },
  });
  assert.equal(took.statusCode, 200);
  const owned = system.store.obstacles.getObstacle(obstacle.id);
  assert.equal(owned?.state, 'owned');
  assert.equal(owned?.ownerRef, 'issue:412');

  const again = await app.inject({
    method: 'POST',
    url: `/api/obstacles/${obstacle.id}/own`,
    payload: { ownerRef: 'issue:500' },
  });
  assert.equal(again.statusCode, 409);
  assert.match(String(again.json().error), /issue:412/);
  assert.equal(system.store.obstacles.getObstacle(obstacle.id)?.ownerRef, 'issue:412');

  await app.close();
  system.store.close();
});

test('retiring is not rejecting: the row keeps what it said, and a matching report reopens it', async () => {
  const system = build();
  const key = [{ kind: 'test' as const, value: 'test/e.test.ts > slow' }];
  const { obstacle } = say(system, 'e.test.ts is slow', 'issue:11', key);
  const { app } = await buildApp(system);

  const retired = await app.inject({ method: 'POST', url: `/api/obstacles/${obstacle.id}/retire` });
  assert.equal(retired.statusCode, 200);
  const after = system.store.obstacles.getObstacle(obstacle.id);
  assert.equal(after?.state, 'resolved');
  assert.equal(after?.endedBy, 'retired');
  assert.equal(after?.what, 'e.test.ts is slow', 'it goes on saying what it said');

  const reopened = say(system, 'e.test.ts is slow', 'issue:12', key);
  assert.equal(reopened.obstacle.id, obstacle.id);
  assert.equal(reopened.obstacle.state, 'standing');
  assert.equal(reopened.obstacle.endedBy, null);
  assert.equal(system.store.obstacles.listObstacleSightings(obstacle.id).length, 2);

  const twice = await app.inject({ method: 'POST', url: `/api/obstacles/${obstacle.id}/retire` });
  assert.equal(twice.statusCode, 200);
  const third = await app.inject({ method: 'POST', url: `/api/obstacles/${obstacle.id}/retire` });
  assert.equal(third.statusCode, 409);

  await app.close();
  system.store.close();
});

test('write it down is a note’s door and refuses an obstacle', async () => {
  const system = build();
  const { obstacle } = say(system, 'the runner image changed', 'issue:11', [
    { kind: 'test', value: 'test/f.test.ts > image' },
  ]);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: `/api/obstacles/${obstacle.id}/write-up` });
  assert.equal(res.statusCode, 409);
  assert.match(String(res.json().error), /only a note/);
  assert.equal(system.store.obstacles.obstaclesWrittenUp().size, 0);

  await app.close();
  system.store.close();
});
