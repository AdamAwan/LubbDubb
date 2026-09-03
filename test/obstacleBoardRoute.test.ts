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

/**
 * The obstacle board's route — the cockpit's whole arm on this store.
 *
 * What is asserted here is the handful of properties that fail **silently**: the
 * page draws only figures something counted, the four controls are the only
 * writes and none of them is a step on any path, and *retiring is not rejecting*
 * — a retired row keeps what it said and a matching report reopens it. Each of
 * those renders perfectly while being wrong, which is why none of them is left to
 * the surface. → `docs/spec/32-obstacles.md#in-the-cockpit`
 */

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

/** One voice, written straight through the store — the intake's own path is `obstacleIntake`'s subject. */
function say(system: System, what: string, goalRef: string | null, keys: { kind: 'test'; value: string }[]) {
  return system.store.recordObstacleSighting(
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
  // The fold is the only place the matcher can be seen working or getting it
  // wrong, so the words and the *why* have to be on the row rather than a second
  // fetch away.
  assert.equal(standing.sightings.length, 2);
  assert.deepEqual(
    standing.sightings.map((sighting) => sighting.goalRef),
    ['issue:11', 'issue:12'],
  );
  assert.equal(standing.sightings[0]!.matchedBy, 'fresh');
  assert.equal(standing.sightings[1]!.matchedBy, 'test:test/a.test.ts > flakes');

  assert.equal(body.counts.sightings, 3);
  assert.equal(body.counts.goals, 3);
  // Nothing has been told anybody, and the page must be able to say so rather
  // than fall back on a figure nothing recorded.
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
  assert.equal(system.store.getObstacle(obstacle.id)?.state, 'muted');

  // The one state whose exit is a person, so the way back is one too.
  const back = await app.inject({
    method: 'POST',
    url: `/api/obstacles/${obstacle.id}/mute`,
    payload: { muted: false },
  });
  assert.equal(back.statusCode, 200);
  assert.equal(system.store.getObstacle(obstacle.id)?.state, 'standing');

  // A refusal is a returned value and a 400, never a throw — and a body that says
  // nothing is refused by name rather than defaulted.
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
  const owned = system.store.getObstacle(obstacle.id);
  assert.equal(owned?.state, 'owned');
  assert.equal(owned?.ownerRef, 'issue:412');

  // The claim is the transition, so *do not all pile on* is a constraint rather
  // than an instruction: a second taker is told who has it.
  const again = await app.inject({
    method: 'POST',
    url: `/api/obstacles/${obstacle.id}/own`,
    payload: { ownerRef: 'issue:500' },
  });
  assert.equal(again.statusCode, 409);
  assert.match(String(again.json().error), /issue:412/);
  assert.equal(system.store.getObstacle(obstacle.id)?.ownerRef, 'issue:412');

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
  const after = system.store.getObstacle(obstacle.id);
  assert.equal(after?.state, 'resolved');
  // Its own ending, so the board never says a clock or the world ended a row a
  // person did.
  assert.equal(after?.endedBy, 'retired');
  assert.equal(after?.what, 'e.test.ts is slow', 'it goes on saying what it said');

  // Nothing here bars a claim by name. The keys survived, so the next report joins
  // the same row and carries it back to standing with its whole history.
  const reopened = say(system, 'e.test.ts is slow', 'issue:12', key);
  assert.equal(reopened.obstacle.id, obstacle.id);
  assert.equal(reopened.obstacle.state, 'standing');
  assert.equal(reopened.obstacle.endedBy, null);
  assert.equal(system.store.listObstacleSightings(obstacle.id).length, 2);

  // The ending that took a row is the first one that did, so a second retire moves
  // nothing rather than restamping it.
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
  assert.equal(system.store.obstaclesWrittenUp().size, 0);

  await app.close();
  system.store.close();
});
