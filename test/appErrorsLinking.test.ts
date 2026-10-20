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

const HOUR = 60 * 60 * 1000;
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
      url: null,
      firstSeen,
      lastSeen: ago(0),
      returnedAt: null,
      recordedAt: ago(0),
    },
    days: [{ day: ago(0).slice(0, 10), count: over.count ?? 5 }],
  };
}

const PRUNE = { dayBefore: '2000-01-01', seenBefore: '2000-01-01T00:00:00.000Z' };

function seed(system: System): void {
  const env = system.store.environments;
  env.recordGoalLanding({ prNumber: 1, goalRef: 'issue:412', sha: A });
  env.recordGoalLanding({ prNumber: 2, goalRef: 'issue:415', sha: B });
  env.recordGoalLanding({ prNumber: 3, goalRef: 'issue:420', sha: C });
  env.recordEnvironmentReach({ sha: A, environment: 'test', status: 'reached', detail: null });
  env.recordEnvironmentReach({ sha: B, environment: 'test', status: 'absent', detail: null });
  env.recordEnvironmentReach({ sha: C, environment: 'test', status: 'reached', detail: null });
  system.store.appErrors.recordRead(
    {
      environment: 'test',
      at: ago(0),
      status: 'ok',
      detail: null,
      deployedSha: A,
      previousSha: null,
      deployedAt: null,
    },
    [group('test', 'Pay.Charge', new Date(Date.now() + 60_000).toISOString())],
    PRUNE,
  );
  system.store.appErrors.recordRead(
    {
      environment: 'live',
      at: ago(0),
      status: 'ok',
      detail: null,
      deployedSha: AFTER,
      previousSha: BEFORE,
      deployedAt: ago(2 * HOUR),
    },
    [
      group('live', 'Orders.Submit', ago(HOUR), { frames: ['/app/src/Orders/OrderService.cs:118'] }),
      group('live', 'Cart.Load', ago(HOUR), { frames: ['C:\\build\\src\\Cart\\Cart.cs:line 40'] }),
      group('live', 'Pay.Charge', new Date(Date.now() + 120_000).toISOString()),
      group('live', 'Health.Ping', ago(HOUR), { frames: ['src/Health.cs'] }),
      group('live', 'Once.Only', ago(HOUR), { frames: ['src/Orders/OrderService.cs'], count: 1 }),
    ],
    PRUNE,
  );
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

  await read(system);
  assert.equal(git.calls.filter((c) => c === `changedFiles:${A}`).length, 1, 'a commit is diffed once, then kept');
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
  const payload = appErrorsView({
    environments: ENVIRONMENTS,
    reads: system.store.appErrors.listReads(),
    groups: system.store.appErrors.listGroups(),
    project: 'acme-api',
    minCount: 2,
    ignore: [],
    now: Date.now(),
  });
  await new AppErrorLinker({ git: new SlowGit(), deadlineMs: 20 }).link(payload, {
    landings: system.store.environments.listGoalLandings(),
    readings: system.store.environments.listEnvironmentReach(),
    nodes: [],
    now: Date.now(),
  });
  const orders = linkOf(payload, 'live', 'Orders.Submit');
  assert.equal(orders?.candidates, null);
  assert.match(orders?.why ?? '', /did not answer within 0s/);
});
