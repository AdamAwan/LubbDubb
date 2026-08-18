import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildClaudeArgs, buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Lesson } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Durable lessons, phase 1 (issue #355): the store, the three states, and the
 * operator gate in front of them.
 *
 * The property most of this file is about is a **negative** one, and it is the
 * reason the ticket was split: a lesson store that reached agents on its
 * author's say-so would be the stale fleet-wide instruction block the issue
 * argues against. So the assertions below are as much about what promotion does
 * *not* do — it changes no launch argument, and no rendered prompt — as about
 * what it does.
 */

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lessons-'));
  return loadConfig({
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

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

// -- the store ----------------------------------------------------------------

test('a lesson lands proposed, carrying the goal it was learned on', () => {
  const { store } = build();
  const lesson = store.proposeLesson({ text: 'The suite wants a built web bundle first.', originRef: 'issue:41' });
  assert.equal(lesson.status, 'proposed');
  assert.equal(lesson.originRef, 'issue:41');
  // Provenance is the half a rendered block strips, so it is asserted here
  // rather than trusted: what it was learned on, and when.
  assert.ok(lesson.createdAt);
  assert.deepEqual(store.getLesson(lesson.id), lesson);
});

test('a lesson with no goal behind it says so, rather than borrowing one', () => {
  const { store } = build();
  assert.equal(store.proposeLesson({ text: 'Rebase before you push.', originRef: null }).originRef, null);
});

test('promotion is one-way and only from a proposal', () => {
  const { store } = build();
  const lesson = store.proposeLesson({ text: 'x', originRef: null });
  assert.equal(store.promoteLesson(lesson.id)?.status, 'promoted');
  // A second click promotes nothing: the guard is in the write, so two racing
  // clicks cannot both find a promotable row.
  assert.equal(store.promoteLesson(lesson.id), null);
  assert.equal(store.promoteLesson('lesn_nothing'), null);
});

test('retiring works from either live status, and is terminal', () => {
  const { store } = build();
  const proposal = store.proposeLesson({ text: 'a', originRef: null });
  const promoted = store.proposeLesson({ text: 'b', originRef: null });
  store.promoteLesson(promoted.id);

  assert.equal(store.retireLesson(proposal.id)?.status, 'retired');
  assert.equal(store.retireLesson(promoted.id)?.status, 'retired');
  // There is no un-retire: a lesson worth bringing back is worth reading again,
  // and the surface must not offer a way to un-prune without one.
  assert.equal(store.retireLesson(promoted.id), null);
  assert.equal(store.promoteLesson(promoted.id), null);
});

test('the list keeps retired lessons, so the prune surface shows what it pruned', () => {
  const { store } = build();
  const kept = store.proposeLesson({ text: 'kept', originRef: null });
  const gone = store.proposeLesson({ text: 'gone', originRef: null });
  store.retireLesson(gone.id);
  const ids = store.listLessons().map((l) => l.id);
  assert.deepEqual(new Set(ids), new Set([kept.id, gone.id]));
});

// -- the routes ---------------------------------------------------------------

test('the three routes are the whole of how a lesson moves', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const written = await app.inject({
    method: 'POST',
    url: '/api/lessons',
    payload: { text: '  Build the web bundle before the suite.  ', originRef: 'issue:41' },
  });
  assert.equal(written.statusCode, 200);
  const { lesson } = written.json() as { lesson: Lesson };
  assert.equal(lesson.status, 'proposed');
  assert.equal(lesson.text, 'Build the web bundle before the suite.');

  assert.equal(
    ((await app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/promote` })).json() as { lesson: Lesson })
      .lesson.status,
    'promoted',
  );
  assert.equal(
    ((await app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/retire` })).json() as { lesson: Lesson })
      .lesson.status,
    'retired',
  );

  await app.close();
});

test('a refusal is a 400/404/409, never a throw', async () => {
  const system = build();
  const { app } = await buildApp(system);

  // A malformed request is refused as a value, through `checked` — not routed to
  // the error handler, which means "unanticipated".
  assert.equal((await app.inject({ method: 'POST', url: '/api/lessons', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/lessons', payload: { text: '   ' } })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/lessons', payload: { text: 'x'.repeat(2_001) } })).statusCode,
    400,
  );

  // An id that names nothing is a 404 whatever its status would have been; a
  // lesson already ruled on is a 409 that says which way.
  assert.equal((await app.inject({ method: 'POST', url: '/api/lessons/nope/promote' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/lessons/nope/retire' })).statusCode, 404);

  const lesson = system.store.proposeLesson({ text: 'x', originRef: null });
  system.store.retireLesson(lesson.id);
  const again = await app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/promote` });
  assert.equal(again.statusCode, 409);
  assert.match((again.json() as { error: string }).error, /retired/);

  await app.close();
});

test('the snapshot ships every lesson, at every status', async () => {
  const system = build();
  const promoted = system.store.proposeLesson({ text: 'promoted', originRef: 'issue:9' });
  system.store.promoteLesson(promoted.id);
  const retired = system.store.proposeLesson({ text: 'retired', originRef: null });
  system.store.retireLesson(retired.id);
  system.store.proposeLesson({ text: 'proposed', originRef: null });

  const { app } = await buildApp(system);
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as { lessons: Lesson[] };
  assert.deepEqual(
    new Set(snap.lessons.map((l) => l.status)),
    new Set(['proposed', 'promoted', 'retired']),
    'the panel draws all three, so all three ship',
  );
  await app.close();
});

// -- what promotion deliberately does not do ----------------------------------

test('a promoted lesson changes no launch argument', () => {
  const system = build();
  const before = { pty: buildClaudeArgs({}), stream: buildClaudeStreamArgs({}) };

  const lesson = system.store.proposeLesson({ text: 'Never skip the build step.', originRef: 'issue:41' });
  system.store.promoteLesson(lesson.id);

  // The acceptance criterion phase 1 has to hold on its own: with lessons in the
  // store — promoted ones included — the arguments are byte-identical to what
  // they were, because nothing renders a lesson yet. Rendering is #355 phase 3,
  // and when it lands this assertion is what says the empty case still matches.
  assert.deepEqual(buildClaudeArgs({}), before.pty);
  assert.deepEqual(buildClaudeStreamArgs({}), before.stream);
});

/**
 * Every way a module could touch the store, so the two tests below can say which
 * of them each part of the harness is allowed.
 *
 * Named methods rather than the word "lesson", which is what this assertion used
 * to look for. That proxy outlived its usefulness the moment a *prompt* had to
 * tell an agent the channel exists: `issue-retro`'s template names lessons in
 * prose, which is the dispatcher describing a tool, not a rule consulting the
 * table. Matching the API is both narrower and truer to the property — the thing
 * that would actually break it is a call.
 */
const LESSON_READS = ['listLessons', 'getLesson'];
const LESSON_VERDICTS = ['promoteLesson', 'retireLesson'];
const LESSON_WRITE = 'proposeLesson';

test('no dispatch or execution path touches the lesson store at all', () => {
  // Structural, in the shape `test/workGraph.test.ts` uses for the lens rule, and
  // for the same reason: the property is "no lesson reaches an agent", and no
  // behavioural test can see the day someone adds the one line that breaks it.
  //
  // These two directories are shut permanently, in every direction. A rule that
  // consulted a lesson would be the dispatcher taking a second opinion about a
  // decision made elsewhere, which is the same objection the lens rule states;
  // and a rule that *wrote* one would be the harness proposing claims to itself
  // with no run behind them. Phase 3's rendering path is neither of these — it
  // reads promoted lessons in `src/agents/agentProtocol.ts`, which is why that
  // directory is governed by the test below instead.
  for (const dir of ['src/dispatcher', 'src/executor']) {
    for (const file of srcFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      for (const method of [...LESSON_READS, ...LESSON_VERDICTS, LESSON_WRITE]) {
        assert.equal(
          source.includes(method),
          false,
          `${file} calls ${method}; nothing on this path may touch a lesson`,
        );
      }
      assert.equal(/from '.*lessons\.js'/.test(source), false, `${file} imports a lessons module`);
    }
  }
  // …and this proves the search above is looking somewhere real.
  assert.ok(srcFiles('src/dispatcher').length > 5, 'the dispatcher was read');
});

test('the tool channel may propose a lesson and nothing else', () => {
  // The half of the rule phase 2 did *not* relax. Filing a proposal is a claim
  // an operator still has to read; reading the list back would hand an agent the
  // fleet's promoted claims through a side door, ahead of the capped, spec'd
  // block phase 3 owes it — and ruling on one would be the gate deciding for the
  // person it exists for.
  for (const dir of ['src/mcp', 'src/agents']) {
    for (const file of srcFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      for (const method of [...LESSON_READS, ...LESSON_VERDICTS]) {
        assert.equal(
          source.includes(method),
          false,
          `${file} calls ${method}; the channel may propose, never read or rule`,
        );
      }
    }
  }
  // And the write it *is* allowed is really there, so this test cannot pass by
  // the whole feature having been deleted.
  assert.ok(
    srcFiles('src/agents').some((f) => readFileSync(f, 'utf8').includes(LESSON_WRITE)),
    'the retrospective still files its lessons',
  );
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
