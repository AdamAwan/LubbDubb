import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import type { Lesson } from '../src/types.js';
import { buildClaudeArgs, buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { LessonView } from '../src/wire.js';
import { renderKnowledgeBlock } from '../src/knowledge/block.js';
import type { StreamChild } from '../src/agents/streamJsonSession.js';
import { failPlanningOpen } from './support/plans.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Durable lessons, phase 1 (issue #355): the store, the three states, and the
 * operator gate in front of them.
 *
 * The property most of this file is about is a **negative** one, and it is the
 * reason the ticket was split: a lesson store that reached agents on its
 * author's say-so would be the stale fleet-wide instruction block the issue
 * argues against. So the assertions below are as much about what promotion does
 * *not* do — a proposal reaches nobody, a retired claim stops reaching anybody,
 * and with nothing promoted the launch arguments are byte-identical to a build
 * without the feature — as about what it does.
 *
 * Delivery itself moved to the knowledge base in issue #27 phase 3: a promoted
 * lesson is mirrored in as an injected fleet claim and rides *that* block, so the
 * launch assertions below are end-to-end over the mirror — which is the half that
 * must not break silently, since a lesson that stopped reaching agents would look
 * exactly like one nobody promoted. The renderer's own bounds are
 * `test/knowledgeBlock.test.ts`.
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

  // The acceptance criterion phase 1 had to hold on its own, and phase 3 did not
  // get to soften it: with lessons in the store — promoted ones included — a
  // launch carrying no rendered block is byte-identical to what it was before any
  // of this existed. Not an empty header, not a trailing newline. The block is
  // simply absent unless `src/system.ts` puts one there.
  assert.deepEqual(buildClaudeArgs({}), before.pty);
  assert.deepEqual(buildClaudeStreamArgs({}), before.stream);
});

// -- what phase 3 renders ------------------------------------------------------

/**
 * Real dispatches, and the argv each launched with — the way production reaches
 * the launch path, on the runtime named.
 *
 * At the `buildSystem` seam rather than by calling a builder with hand-written
 * options, because the thing most likely to break is the wiring: `src/system.ts`
 * is the only module on this path that knows lessons exist, and a builder that
 * accepts the block and forgets to forward it type-checks clean and drops it
 * silently — the trap `ArgsBuilder`'s own comment names for `model`.
 */
async function dispatchLaunches(
  agentMode: 'stream' | 'pty',
  seed: (system: System) => void,
  issues: number[],
): Promise<string[][]> {
  const launches: string[][] = [];
  const backend = new FakePtyBackend();
  const system = buildSystem(
    { ...testConfig(), agentMode },
    {
      worktrees: new FakeWorktreeManager(),
      backend,
      streamSpawner: (_command, args) => {
        launches.push(args);
        return new FakeChild();
      },
      errorMirror: () => {},
    },
  );
  seed(system);
  for (const number of issues) {
    system.connector.inject({ kind: 'new_issue', number, title: `Add login ${number}` });
    failPlanningOpen(system.store, number);
  }
  await system.harness.runCycle('manual');
  const args = agentMode === 'stream' ? launches : backend.spawned.map((s) => s.args);
  system.store.close();
  assert.equal(args.length, issues.length, `${agentMode} dispatched ${args.length} agents, expected ${issues.length}`);
  return args;
}

/** What a launch appends to the system prompt — the protocol, and the lessons. */
function appendedPrompt(args: string[]): string {
  const value = args[args.indexOf('--append-system-prompt') + 1];
  assert.ok(value, 'the launch carried no appended system prompt');
  return value;
}

test('a promoted lesson rides in both runtimes\u2019 launch arguments; a retired one does not', async () => {
  for (const agentMode of ['stream', 'pty'] as const) {
    const [args] = await dispatchLaunches(
      agentMode,
      (system) => {
        const kept = system.store.proposeLesson({ text: 'Build the web bundle first.', originRef: 'issue:41' });
        const gone = system.store.proposeLesson({ text: 'Take the devops lock first.', originRef: 'issue:9' });
        system.store.promoteLesson(kept.id);
        system.store.promoteLesson(gone.id);
        system.store.retireLesson(gone.id);
        // A proposal is not a claim anyone vouched for. The gate is the reason
        // this store is allowed to exist, so the launch may not route around it.
        system.store.proposeLesson({ text: 'Unvouched claim.', originRef: null });
      },
      [771],
    );
    const prompt = appendedPrompt(args!);
    assert.match(prompt, /Build the web bundle first\./, `${agentMode} must carry a promoted lesson`);
    // Provenance rides with it: what taught the claim and when are what let an
    // agent discount a stale one, and a bare block of assertions strips exactly
    // that.
    assert.match(prompt, /first seen on issue:41/, `${agentMode} must carry the lesson's provenance`);
    assert.doesNotMatch(prompt, /devops lock/, `${agentMode} must not carry a retired lesson`);
    assert.doesNotMatch(prompt, /Unvouched claim\./, `${agentMode} must not carry a proposal`);
  }
});

test('the block is byte-identical between two dispatches', async () => {
  const launches = await dispatchLaunches(
    'stream',
    (system) => {
      const lesson = system.store.proposeLesson({ text: 'The suite wants a built bundle.', originRef: 'issue:41' });
      system.store.promoteLesson(lesson.id);
    },
    [881, 882],
  );
  const [first, second] = launches.map(appendedPrompt);
  // Two goals, two branches, two sessions — and the same appended prompt. The
  // block is worth putting in the system prompt only because it is a cached
  // prefix, and it is only cacheable while it is the same bytes for every agent
  // on every dispatch. So nothing per-dispatch may enter it: no goal name, no
  // branch, no agent id, no timestamp of "now".
  assert.notEqual(
    launches[0]![launches[0]!.indexOf('--session-id') + 1],
    launches[1]![launches[1]!.indexOf('--session-id') + 1],
    'the two launches must really be two dispatches',
  );
  assert.equal(first, second);
  assert.ok(first!.includes('The suite wants a built bundle.'), 'and the block is actually in there');
});

test('the cockpit is told which promoted lessons are actually reaching agents', async () => {
  const system = build();
  const older = system.store.proposeLesson({ text: 'a'.repeat(300), originRef: null });
  const newer = system.store.proposeLesson({ text: 'b'.repeat(300), originRef: null });
  system.store.promoteLesson(older.id);
  system.store.promoteLesson(newer.id);
  // A cap that fits one of the two, so the snapshot has a real drop to report.
  system.config.knowledgeBlockChars =
    renderKnowledgeBlock(system.store.askFacts({ scopes: ['fleet'], limit: 500 }), 6_000).text.length - 1;

  const { app } = await buildApp(system);
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as { lessons: LessonView[] };
  const byId = new Map(snap.lessons.map((l) => [l.id, l.rendered]));
  // Per row, and only the operator sees it: the agent is never told the list it
  // reads is partial, which is the failure the cap exists to bound. The operator
  // is told exactly *which* claim is not reaching anyone, because "one is over
  // the cap" leaves them to work out which before they can retire something.
  assert.equal(byId.get(newer.id), true, 'the newest-vouched claim is the one that fits');
  assert.equal(byId.get(older.id), false, 'the dropped claim is marked, not merely absent');
  await app.close();
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
  // renders promoted lessons from `src/system.ts`, the composition root, which is
  // the only module on the launch path that knows lessons exist at all.
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
  // The half of the rule neither later phase relaxed. Filing a proposal is a
  // claim an operator still has to read; reading the list back would hand an
  // agent the fleet's promoted claims through a side door, beside the capped,
  // spec'd block phase 3 renders — and ruling on one would be the gate deciding
  // for the person it exists for. It is also why that block reaches
  // `agentProtocol.ts` as a finished *string*: a seam that made this assertion
  // fail would be the wrong seam.
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

/** A `claude` stream-JSON process that is only ever spawned and read back. */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 771;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
