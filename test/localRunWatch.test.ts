import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { LocalRunWatch } from '../src/localRun/watch.js';
import { descendants, parseLsof, parseSs, probePort } from '../src/localRun/ports.js';
import { FakePortLister } from '../src/localRun/fakePortLister.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { LocalRun } from '../src/types.js';

/**
 * The readings on the local run: what is listening, and how far behind the checkout
 * has fallen. Two properties carry the design:
 *
 * 1. **Every reading is three-valued, and null is never a zero.** A lister that could
 *    not say, a clone that has not fetched, a URL with no port — each is "could not
 *    say", and folding any of them into `[]` or `0` would draw a reading nothing took.
 * 2. **`changed` fires when a reading changes, not when a reading is taken.** Every
 *    `dirty` costs every cockpit a snapshot, and a steady environment is read every
 *    ten seconds for the life of the run.
 */

const T0 = Date.parse('2026-09-02T09:00:00.000Z');

function run(over: Partial<LocalRun> = {}): LocalRun {
  return {
    id: 'r1',
    originRef: 'issue:284',
    ref: 'issue/284/x',
    dir: '/preview',
    commit: 'abc123',
    pid: 4242,
    status: 'running',
    url: 'http://localhost:5173',
    note: null,
    startedAt: new Date(T0).toISOString(),
    endedAt: null,
    interruptedAt: null,
    lastSeenAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    ...over,
  };
}

function build(
  over: {
    run?: LocalRun | null;
    fetch?: () => Promise<void>;
    baseFor?: (originRef: string, ref: string) => string | null;
    probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    gitIntervalMs?: number;
    fetchIntervalMs?: number;
  } = {},
) {
  let current: LocalRun | null = over.run === undefined ? run() : over.run;
  let clock = T0;
  const runner = new EventEmitter();
  const git = new FakeGitObserver();
  const ports = new FakePortLister();
  const errors: string[] = [];
  const changed: number[] = [];
  const probed: string[] = [];
  const watch = new LocalRunWatch({
    runner: { current: () => current, on: (event, cb) => runner.on(event, cb) },
    git,
    fetch: over.fetch,
    ports,
    probe:
      over.probe ??
      ((host, port) => {
        probed.push(`${host}:${String(port)}`);
        return Promise.resolve(true);
      }),
    baseFor: over.baseFor ?? (() => 'main'),
    now: () => clock,
    gitIntervalMs: over.gitIntervalMs ?? 60_000,
    fetchIntervalMs: over.fetchIntervalMs ?? 60_000,
    errors: {
      record: (input) => {
        errors.push(input.message);
        return { ...input, id: 'e1', detail: input.detail ?? null, createdAt: new Date(clock).toISOString() };
      },
    },
  });
  watch.on('changed', () => changed.push(clock));
  return {
    watch,
    git,
    ports,
    errors,
    changed,
    probed,
    runner,
    set: (next: LocalRun | null) => {
      current = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('nothing live is nothing read, and nobody is asked', async () => {
  const { watch, git, ports, changed } = build({ run: null });
  await watch.tick();
  assert.deepEqual(watch.reading(), { ports: null, freshness: null });
  assert.deepEqual(git.calls, []);
  assert.deepEqual(ports.calls, []);
  assert.deepEqual(changed, [], 'nothing changed, so nothing was announced');

  const settled = build({ run: run({ status: 'stopped' }) });
  await settled.watch.tick();
  assert.deepEqual(settled.watch.reading(), { ports: null, freshness: null });
  assert.deepEqual(settled.ports.calls, [], 'a settled row is not live, whatever its pid says');
});

test('the ports reading: the declared URL probed, the process tree listed', async () => {
  const { watch, ports, probed } = build();
  ports.set(4242, [5432, 5173]);
  await watch.tick();
  const reading = watch.reading().ports;
  assert.deepEqual(probed, ['localhost:5173']);
  assert.deepEqual(reading?.declared, { url: 'http://localhost:5173', host: 'localhost', port: 5173, answering: true });
  assert.deepEqual(reading?.listening, [5432, 5173], 'as the lister said; the real one sorts');
  assert.equal(reading?.checkedAt, new Date(T0).toISOString());
});

test('the ports reading’s nulls each mean what they say', async () => {
  // No port in the URL is the scheme's port, not nothing.
  const bare = build({ run: run({ url: 'http://example.test/app' }) });
  await bare.watch.tick();
  assert.equal(bare.watch.reading().ports?.declared?.port, 80);
  const tls = build({ run: run({ url: 'https://example.test' }) });
  await tls.watch.tick();
  assert.equal(tls.watch.reading().ports?.declared?.port, 443);

  // No URL, no probe — and nothing recorded about it every ten seconds.
  const none = build({ run: run({ url: null }) });
  await none.watch.tick();
  assert.equal(none.watch.reading().ports?.declared, null);
  assert.deepEqual(none.probed, []);
  const junk = build({ run: run({ url: 'not a url' }) });
  await junk.watch.tick();
  assert.equal(junk.watch.reading().ports?.declared, null);
  assert.deepEqual(junk.errors, [], 'a bad URL is a reading, not a fault');

  // No pid, nothing to walk. A lister that has nothing to say about the pid says so.
  const orphan = build({ run: run({ pid: null }) });
  await orphan.watch.tick();
  assert.equal(orphan.watch.reading().ports?.listening, null);
  assert.deepEqual(orphan.ports.calls, []);
  const mute = build();
  await mute.watch.tick();
  assert.equal(mute.watch.reading().ports?.listening, null, 'unset is "could not say", never an empty list');
  assert.deepEqual(mute.ports.calls, [4242]);

  // A port nothing answers on.
  const dark = build({ probe: () => Promise.resolve(false) });
  await dark.watch.tick();
  assert.equal(dark.watch.reading().ports?.declared?.answering, false);
});

test('the freshness reading: behind the tip, and behind the base', async () => {
  const { watch, git } = build();
  // The ref has three commits the checkout does not — an agent pushed since the start.
  git.setDivergence('issue/284/x', 'abc123', { ahead: 3, behind: 0 });
  // And the base has two the ref has not picked up.
  git.setDivergence('issue/284/x', 'main', { ahead: 5, behind: 2 });
  await watch.tick();
  const reading = watch.reading().freshness;
  assert.equal(reading?.behindTip, 3);
  assert.deepEqual(reading?.base, { ref: 'main', behind: 2 });
  assert.deepEqual(git.calls, ['divergence:issue/284/x...abc123', 'divergence:issue/284/x...main']);
});

test('the freshness reading’s nulls each mean what they say', async () => {
  // A clone that cannot compare says so, in both places.
  const unknown = build();
  await unknown.watch.tick();
  assert.equal(unknown.watch.reading().freshness?.behindTip, null);
  assert.deepEqual(unknown.watch.reading().freshness?.base, { ref: 'main', behind: null });

  // A row from before the commit was recorded has nothing to measure from.
  const old = build({ run: run({ commit: null }) });
  old.git.setDivergence('issue/284/x', 'main', { ahead: 1, behind: 1 });
  await old.watch.tick();
  assert.equal(old.watch.reading().freshness?.behindTip, null);
  assert.equal(old.git.calls.length, 1, 'the base is still asked about');

  // The integration branch has no base.
  const main = build({ run: run({ ref: 'main' }), baseFor: () => null });
  main.git.setDivergence('main', 'abc123', { ahead: 0, behind: 0 });
  await main.watch.tick();
  assert.equal(main.watch.reading().freshness?.behindTip, 0);
  assert.equal(main.watch.reading().freshness?.base, null);

  // Git throwing is recorded once per distinct message, and the reading still lands.
  const broken = build();
  broken.git.divergence = () => Promise.reject(new Error('fatal: not a git repository'));
  await broken.watch.tick();
  assert.equal(broken.watch.reading().freshness?.behindTip, null);
  assert.equal(broken.watch.reading().ports?.declared?.answering, true, 'the ports half is unaffected');
  assert.deepEqual(broken.errors, ['The local run watch could not ask git: fatal: not a git repository']);
});

test('git is asked on its own cadence, ports on every tick', async () => {
  const { watch, git, ports, advance } = build();
  ports.set(4242, [5173]);
  await watch.tick();
  advance(10_000);
  await watch.tick();
  advance(10_000);
  await watch.tick();
  assert.equal(ports.calls.length, 3);
  assert.equal(git.calls.length, 2, 'one tick’s worth: the tip and the base, once');
  advance(60_000);
  await watch.tick();
  assert.equal(git.calls.length, 4);
});

test('the fetch runs once per interval, and a failure is recorded once', async () => {
  let fetches = 0;
  const { watch, advance, errors } = build({ fetch: () => Promise.resolve(void (fetches += 1)) });
  await watch.tick();
  await watch.tick();
  assert.equal(fetches, 1);
  advance(60_000);
  await watch.tick();
  assert.equal(fetches, 2);
  assert.deepEqual(errors, []);

  const failing = build({ fetch: () => Promise.reject(new Error('fatal: no remote')) });
  await failing.watch.tick();
  failing.advance(60_000);
  await failing.watch.tick();
  // A repo with no `origin` would otherwise say so every minute for ever.
  assert.deepEqual(failing.errors, ['The local run watch could not fetch: fatal: no remote']);
  assert.ok(failing.watch.reading().ports !== null, 'the readings still land');
});

test('a change of run clears the readings and asks again at once', async () => {
  const { watch, git, ports, set, advance } = build();
  ports.set(4242, [5173]);
  git.setDivergence('issue/284/x', 'abc123', { ahead: 1, behind: 0 });
  await watch.tick();
  assert.equal(watch.reading().freshness?.behindTip, 1);

  // Another run, ten seconds later — inside the git interval, which the change resets.
  advance(10_000);
  set(run({ id: 'r2', ref: 'issue/9/y', commit: 'def456', pid: 99 }));
  git.setDivergence('issue/9/y', 'def456', { ahead: 0, behind: 0 });
  await watch.tick();
  assert.equal(watch.reading().ports?.listening, null, 'the new pid has nothing declared');
  assert.equal(watch.reading().freshness?.behindTip, 0, 'and its freshness is its own, not the last run’s');
});

test('a run that settles takes its readings with it, and says so once', async () => {
  const { watch, changed, set, ports, advance } = build();
  ports.set(4242, [5173]);
  await watch.tick();
  assert.equal(changed.length, 1);
  advance(10_000);
  set(run({ status: 'stopped' }));
  await watch.tick();
  assert.deepEqual(watch.reading(), { ports: null, freshness: null });
  assert.equal(changed.length, 2);
  await watch.tick();
  assert.equal(changed.length, 2, 'nothing to nothing is not a change');
});

test('identical readings are not announced', async () => {
  const { watch, changed, ports, advance } = build();
  ports.set(4242, [5173]);
  await watch.tick();
  advance(10_000);
  await watch.tick();
  advance(10_000);
  await watch.tick();
  assert.equal(changed.length, 1, 'three ticks, one change — `checkedAt` moving is not news');
  ports.set(4242, [5173, 5432]);
  advance(10_000);
  await watch.tick();
  assert.equal(changed.length, 2);
});

test('the runner announcing a new run or status nudges a reading without waiting out the interval', async () => {
  const { watch, runner, ports, set } = build({ run: run({ status: 'starting' }) });
  ports.set(4242, [5173]);
  await watch.tick();
  assert.equal(watch.reading().ports?.listening?.length, 1);
  // Unarmed, nothing happens in the background: every test builds a `System`, and a
  // reading scheduled off a start would land after the test had closed its store.
  set(run({ status: 'running' }));
  runner.emit('changed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ports.calls.length, 1, 'an unarmed watch reads only when asked');
  set(run({ status: 'starting' }));
  await watch.tick();
  watch.start();
  // The bring-up ends: the runner says `changed`, and the watch reads again at once
  // rather than up to ten seconds later, which is exactly when somebody is looking.
  set(run({ status: 'running' }));
  ports.set(4242, [5173, 5432]);
  runner.emit('changed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(watch.reading().ports?.listening, [5173, 5432]);
  // Output lines say `changed` too, and none of them is a new shape.
  const before = ports.calls.length;
  runner.emit('changed');
  runner.emit('changed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ports.calls.length, before, 'the same run in the same status is not re-read');
  watch.stop();
});

// -- the port lister’s pure parts ---------------------------------------------

test('descendants walks parent links from the root, and survives a cycle', () => {
  const table = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 20, ppid: 1 },
    // A reused pid pointing at its own grandchild: two commands are not a snapshot.
    { pid: 10, ppid: 12 },
  ];
  assert.deepEqual(
    [...descendants(10, table)].sort((a, b) => a - b),
    [10, 11, 12],
  );
  assert.deepEqual([...descendants(20, table)], [20]);
  assert.deepEqual([...descendants(99, table)], [99], 'a root nothing knows is still the root');
});

test('parseSs reads the port and every holding pid off a listening socket line', () => {
  const out = [
    'LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=123,fd=22))',
    'LISTEN 0 4096 [::1]:5432 [::]:* users:(("postgres",pid=77,fd=6),("postgres",pid=78,fd=6))',
    'LISTEN 0 128 *:22 *:*',
    '',
  ].join('\n');
  assert.deepEqual(parseSs(out), [
    { port: 5173, pid: 123 },
    { port: 5432, pid: 77 },
    { port: 5432, pid: 78 },
  ]);
});

test('parseLsof pairs each socket line with the pid line above it', () => {
  const out = ['p123', 'n*:5173', 'n127.0.0.1:9229', 'p77', 'n[::1]:5432', ''].join('\n');
  assert.deepEqual(parseLsof(out), [
    { port: 5173, pid: 123 },
    { port: 9229, pid: 123 },
    { port: 5432, pid: 77 },
  ]);
});

test('probePort answers true for a held port and false for a free one', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  assert.equal(await probePort('127.0.0.1', port, 1000), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probePort('127.0.0.1', port, 1000), false);
});
