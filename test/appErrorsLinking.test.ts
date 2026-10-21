import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeAppErrorReader } from '../src/appErrors/fakeReader.js';
import { AppErrorLinker } from '../src/appErrors/linker.js';
import { appErrorsView } from '../src/appErrors/view.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { AppErrorsPayload } from '../src/wire.js';

const ENVIRONMENTS: EnvironmentConfig[] = [
  { name: 'test', at: 'unused', errors: { list: './errors.sh test {since}' } },
  { name: 'live', at: 'unused', errors: { list: './errors.sh live {since}' } },
];

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const sha = (c: string): string => c.repeat(40);
const [A, B, C, BEFORE, AFTER] = [sha('a'), sha('b'), sha('c'), sha('d'), sha('e')];

function build(git: FakeGitObserver): System {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    heartbeatIntervalMs: 60_000,
    environments: ENVIRONMENTS,
    pool: { project: 'acme-api' },
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentProber: new FakeEnvironmentProber(),
    appErrorReader: new FakeAppErrorReader(),
    gitObserver: git,
  });
}

const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

function group(
  environment: string,
  fingerprint: string,
  firstSeen: string,
  over: { frames?: string[]; count?: number } = {},
) {
  return {
    group: {
      environment,
      fingerprint,
      title: `${fingerprint} failed`,
      operation: 'POST /orders',
      version: null,
      frames: over.frames ?? [],
      message: null,
      stack: null,
      url: null,
      firstSeen,
      lastSeen: firstSeen,
      returnedAt: null,
    },
    days: [{ day: firstSeen.slice(0, 10), count: over.count ?? 5 }],
  };
}

function seed(system: System): void {
  const env = system.store.environments;
  env.recordGoalLanding({ prNumber: 1, goalRef: 'issue:412', sha: A });
  env.recordGoalLanding({ prNumber: 2, goalRef: 'issue:415', sha: B });
  env.recordGoalLanding({ prNumber: 3, goalRef: 'issue:420', sha: C });
  env.recordEnvironmentReach({ sha: A, environment: 'test', status: 'reached', detail: null });
  env.recordEnvironmentReach({ sha: B, environment: 'test', status: 'absent', detail: null });
  env.recordEnvironmentReach({ sha: C, environment: 'test', status: 'reached', detail: null });
  env.recordEnvironmentHead('test', A);
  env.recordEnvironmentHead('live', BEFORE);
  env.recordEnvironmentHead('live', AFTER);
  system.store.appErrors.recordRead({ environment: 'test', readAt: ago(0), status: 'ok', detail: null }, [
    group('test', 'Pay.Charge', soon(60_000)),
  ]);
  system.store.appErrors.recordRead({ environment: 'live', readAt: ago(0), status: 'ok', detail: null }, [
    group('live', 'Orders.Submit', soon(30_000), { frames: ['/app/src/Orders/OrderService.cs:118'] }),
    group('live', 'Cart.Load', soon(30_000), { frames: ['C:\\build\\src\\Cart\\Cart.cs:line 40'] }),
    group('live', 'Pay.Charge', soon(120_000)),
    group('live', 'Health.Ping', soon(30_000), { frames: ['src/Health.cs'] }),
    group('live', 'Once.Only', soon(30_000), { frames: ['src/Orders/OrderService.cs'], count: 1 }),
  ]);
}

function scripted(): FakeGitObserver {
  return new FakeGitObserver()
    .setContains(AFTER, A, true)
    .setContains(AFTER, B, true)
    .setContains(AFTER, C, true)
    .setContains(BEFORE, A, false)
    .setContains(BEFORE, B, false)
    .setContains(BEFORE, C, true)
    .setChangedFiles(A, ['src/Orders/OrderService.cs', 'src/Orders/Order.cs'])
    .setChangedFiles(B, ['src/Cart/Cart.cs']);
}

async function read(system: System): Promise<AppErrorsPayload> {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/app-errors' });
  assert.equal(res.statusCode, 200);
  await app.close();
  return res.json<AppErrorsPayload>();
}

function viewOf(system: System): AppErrorsPayload {
  return appErrorsView({
    environments: ENVIRONMENTS,
    reads: system.store.appErrors.listReads(),
    groups: system.store.appErrors.listGroups(),
    heads: system.store.environments.listEnvironmentHeads(),
    project: 'acme-api',
    minCount: 2,
    ignore: [],
    now: Date.now(),
  });
}

function linkOf(payload: AppErrorsPayload, environment: string, fingerprint: string) {
  const env = payload.environments.find((e) => e.environment === environment);
  const g = env?.groups.find((x) => x.fingerprint === fingerprint);
  assert.ok(g, `${environment} ${fingerprint} is drawn`);
  return g.link;
}

test('GET /api/app-errors links a moved group to the goal whose landed diff its frames are in', async () => {
  const git = scripted();
  const system = build(git);
  seed(system);

  const payload = await read(system);

  const orders = linkOf(payload, 'live', 'Orders.Submit');
  assert.equal(orders?.goalRef, 'issue:412');
  assert.deepEqual(orders?.how, ['frame-match']);
  assert.equal(orders?.candidates, 2, 'C was already in the build before the deploy');
  assert.match(
    orders?.why ?? '',
    /OrderService\.cs changed only by #412, of 2 goals in the deploy window ddddddd\.\.eeeeeee/,
  );

  assert.equal(linkOf(payload, 'live', 'Cart.Load')?.goalRef, 'issue:415', 'a Windows frame meets a repo path');

  const pay = linkOf(payload, 'live', 'Pay.Charge');
  assert.equal(pay?.goalRef, 'issue:412', 'it went new on test when #412 arrived there');
  assert.deepEqual(pay?.how, ['test-arrival']);

  const ping = linkOf(payload, 'live', 'Health.Ping');
  assert.equal(ping?.goalRef, null);
  assert.equal(ping?.candidates, 2);

  assert.equal(linkOf(payload, 'live', 'Once.Only'), null, 'a muted group is not linked');
  assert.equal(
    git.calls.filter((c) => c === `changedFiles:${A}`).length,
    1,
    'only the deploy window is diffed, and once',
  );

  const asked = git.calls.length;
  await read(system);
  assert.equal(git.calls.length, asked, 'nothing moved, so the linked payload is shared and the clone is not asked');

  system.store.appErrors.recordRead({ environment: 'test', readAt: ago(-1000), status: 'ok', detail: null }, [
    group('test', 'Pay.Charge', soon(60_000)),
  ]);
  await read(system);
  assert.equal(git.calls.filter((c) => c === `changedFiles:${A}`).length, 1, 'a commit is diffed once, then kept');
});

test('a commit the clone could not diff is not asked about again until the failure is ten minutes old', async () => {
  const git = new FakeGitObserver()
    .setContains(AFTER, A, true)
    .setContains(AFTER, B, true)
    .setContains(AFTER, C, true)
    .setContains(BEFORE, A, false)
    .setContains(BEFORE, B, false)
    .setContains(BEFORE, C, true)
    .setChangedFiles(B, ['src/Cart/Cart.cs']);
  const system = build(git);
  seed(system);
  let clock = Date.now();
  const linker = new AppErrorLinker({ git, now: () => clock });
  const pass = async (): Promise<AppErrorsPayload> => {
    const payload = viewOf(system);
    await linker.link(payload, {
      landings: system.store.environments.listGoalLandings(),
      readings: system.store.environments.listEnvironmentReach(),
      nodes: [],
      now: Date.now(),
    });
    return payload;
  };
  const diffsOfA = (): number => git.calls.filter((c) => c === `changedFiles:${A}`).length;

  const first = await pass();
  assert.match(linkOf(first, 'live', 'Orders.Submit')?.why ?? '', /could not list what aaaaaaa changed/);
  assert.equal(diffsOfA(), 1);
  await pass();
  assert.equal(diffsOfA(), 1, 'the failure is remembered');
  clock += 11 * 60_000;
  await pass();
  assert.equal(diffsOfA(), 2, 'and asked again once it is old');
});

test('a landing the clone cannot place leaves the window undecided: no link, and never zero candidates', async () => {
  const git = new FakeGitObserver()
    .setContains(AFTER, A, true)
    .setContains(AFTER, B, true)
    .setContains(BEFORE, A, false)
    .setContains(BEFORE, B, false)
    .setChangedFiles(A, ['src/Orders/OrderService.cs']);
  const system = build(git);
  seed(system);

  const orders = linkOf(await read(system), 'live', 'Orders.Submit');
  assert.equal(orders?.goalRef, null);
  assert.equal(orders?.candidates, null);
  assert.match(orders?.why ?? '', /could not place ccccccc against ddddddd\.\.eeeeeee/);
});

test('a clone that does not answer in time is no link, never a wait', async () => {
  class SlowGit extends FakeGitObserver {
    override contains(): Promise<Map<string, boolean | null>> {
      return new Promise(() => {});
    }
  }
  const system = build(new SlowGit());
  seed(system);
  const payload = viewOf(system);
  const answered = await new AppErrorLinker({ git: new SlowGit(), deadlineMs: 20 }).link(payload, {
    landings: system.store.environments.listGoalLandings(),
    readings: system.store.environments.listEnvironmentReach(),
    nodes: [],
    now: Date.now(),
  });
  assert.equal(answered, false, 'a pass the deadline cut short says so, and is not shared');
  const orders = linkOf(payload, 'live', 'Orders.Submit');
  assert.equal(orders?.candidates, null);
  assert.match(orders?.why ?? '', /did not answer within 0s/);
});
