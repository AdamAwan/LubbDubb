import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { loadExtensions } from '../src/extensions/load.js';
import { buildExtensionHost } from '../src/extensions/host.js';
import { EXTENSION_SLOTS } from '../src/extensions/slots.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeAppErrorDetailRunner, FakeAppErrorReader } from '../src/appErrors/fakeReader.js';
import { ExtensionAppErrorDetailRunner, RoutedAppErrorDetail } from '../src/appErrors/extensionReader.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { mergeShaFor } from '../src/integrations/fake/fakeGitHub.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { GoalWatchInput } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

// → docs/spec/42-extensions.md#the-slots

const HOUR = 60 * 60 * 1000;

const RECORDING = `
const asked = (globalThis.__readingAsked ??= []);
export default { apiVersion: 1, name: 'acme', slots: {
  deployedCommits: (input) => { asked.push(['deployedCommits', input]); return { commits: ['head-ext'] }; },
  appErrors: (input) => {
    asked.push(['appErrors', input]);
    return { query: 'exceptions | summarize', groups: [{
      fingerprint: 'Orders.Submit', title: 'Orders.Submit failed', count: 3,
      firstSeen: new Date(Date.now() - 7200000).toISOString(), lastSeen: new Date(Date.now() - 3600000).toISOString(),
    }] };
  },
  appErrorDetail: (input) => { asked.push(['appErrorDetail', input]); return { text: 'the stack' }; },
  watchReading: (input) => {
    asked.push(['watchReading', input]);
    return input.kind === 'presence' ? [{ runs: 96, lubbdubbWatchId: input.checkId }] : [];
  },
  watchExposure: (input) => { asked.push(['watchExposure', input]); return { share: 0.95 }; },
} };`;

function throwing(slot: string, extra = ''): string {
  return `export default { apiVersion: 1, name: 'acme', slots: {
    ${slot}: () => { throw new Error('the telemetry API said 503'); }, ${extra}
  } };`;
}

function asked(): [string, Record<string, unknown>][] {
  const g = globalThis as { __readingAsked?: [string, Record<string, unknown>][] };
  g.__readingAsked ??= [];
  return g.__readingAsked.splice(0);
}

interface Bench {
  system: System;
  prober: FakeEnvironmentProber;
  reader: FakeAppErrorReader;
  observer: FakeEnvironmentObserver;
  logged: string[];
  repoRoot: string;
}

async function bench(
  source: string | null,
  environments: EnvironmentConfig[],
  over: { repoRoot?: string; dbPath?: string } = {},
): Promise<Bench> {
  const repoRoot = over.repoRoot ?? gitRepo();
  if (source !== null) writeFileSync(join(repoRoot, 'ext.mjs'), source);
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: over.dbPath ?? ':memory:',
    agentMode: 'raw',
    repoRoot,
    deskRoot: join(repoRoot, 'desk'),
    worktreeRoot: join(repoRoot, 'wt'),
    heartbeatIntervalMs: 999_999,
    environmentProbeIntervalMs: 5 * 60 * 1000,
    appErrorIntervalMs: 0,
    appErrorTriagePerDay: 0,
    watchIntervalMs: 1,
    environments,
    extensions: source === null ? [] : ['ext.mjs'],
  });
  const prober = new FakeEnvironmentProber({ staging: ['head-staging'] });
  const reader = new FakeAppErrorReader({ staging: '[]' });
  const observer = new FakeEnvironmentObserver();
  const logged: string[] = [];
  const system = buildSystem(config, {
    extensions: await loadExtensions({ paths: config.extensions, book: EXTENSION_SLOTS }),
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentProber: prober,
    environmentObserver: observer,
    appErrorReader: reader,
    appErrorDetailRunner: new FakeAppErrorDetailRunner(),
    gitObserver: new FakeGitObserver()
      .setContains('head-ext', mergeShaFor(7), true)
      .setContains('head-staging', mergeShaFor(7), false),
    projectConfigFile: join(repoRoot, 'absent.json'),
    errorMirror: (entry) => logged.push(entry.message),
  });
  return { system, prober, reader, observer, logged, repoRoot };
}

const AT_EXT: EnvironmentConfig = { name: 'live', atExtension: true };
const AT_CMD: EnvironmentConfig = { name: 'staging', at: './scripts/deployed-sha.sh' };

function mergedGoal(system: System): void {
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });
}

function reach(system: System, environment: string) {
  return system.store.environments.listEnvironmentReach().find((r) => r.environment === environment);
}

// — the deployed commit —

test('the extension names the deployed commit, and an environment with an `at` command keeps it', async () => {
  asked();
  const { system, prober } = await bench(RECORDING, [AT_EXT, AT_CMD]);
  mergedGoal(system);
  await system.harness.runCycle();

  assert.equal(reach(system, 'live')?.status, 'reached');
  assert.equal(reach(system, 'staging')?.status, 'absent');
  assert.deepEqual(
    asked().filter(([slot]) => slot === 'deployedCommits'),
    [['deployedCommits', { environment: 'live' }]],
  );
  assert.deepEqual(prober.asked, ['staging'], 'no command runs for the environment the extension answers');
});

test('an extension that cannot say where the environment is leaves every landing unknown, never absent', async () => {
  const { system, logged } = await bench(throwing('deployedCommits'), [AT_EXT]);
  mergedGoal(system);
  await system.harness.runCycle();

  const row = reach(system, 'live');
  assert.equal(row?.status, 'unknown');
  assert.match(row?.detail ?? '', /extension "acme" failed the "deployedCommits" slot: the telemetry API said 503/);
  assert.equal(system.store.environments.getEnvironmentHead('live'), null, 'no head is recorded');
  assert.ok(logged.some((m) => /the telemetry API said 503/.test(m)));
});

test('an answer naming no commit is the wrong shape, and unknown', async () => {
  const { system } = await bench(
    `export default { apiVersion: 1, name: 'acme', slots: { deployedCommits: () => ({ commits: [] }) } };`,
    [AT_EXT],
  );
  mergedGoal(system);
  await system.harness.runCycle();
  assert.equal(reach(system, 'live')?.status, 'unknown');
  assert.match(reach(system, 'live')?.detail ?? '', /wrong shape/);
});

test('after a restart the extension is simply asked again: nothing was left running', async () => {
  const repoRoot = gitRepo();
  const dbPath = join(repoRoot, 'state.db');
  const first = await bench(RECORDING, [{ ...AT_EXT, errors: { extension: true } }], { repoRoot, dbPath });
  await first.system.harness.runCycle();
  assert.equal(first.system.store.environments.getEnvironmentHead('live')?.sha, 'head-ext');
  first.system.store.close();
  asked();

  const second = await bench(RECORDING, [{ ...AT_EXT, errors: { extension: true } }], { repoRoot, dbPath });
  await second.system.harness.runCycle();
  assert.ok(asked().some(([slot]) => slot === 'deployedCommits'));
  const head = second.system.store.environments.getEnvironmentHead('live');
  assert.equal(head?.sha, 'head-ext');
  assert.equal(head?.changedAt, null, 'the same head again is no deploy');
  second.system.store.close();
});

// — app errors —

const ERRORS_EXT: EnvironmentConfig = { name: 'live', at: './scripts/sha.sh', errors: { extension: true } };
const ERRORS_CMD: EnvironmentConfig = { name: 'staging', at: './scripts/sha.sh', errors: { list: './e.sh {since}' } };

test('the extension lists the error groups, read by the command’s contract, while commands answer the rest', async () => {
  asked();
  const { system, reader } = await bench(RECORDING, [ERRORS_EXT, ERRORS_CMD]);
  await system.harness.runCycle();

  const reads = new Map(system.store.appErrors.listReads().map((r) => [r.environment, r]));
  assert.equal(reads.get('live')?.status, 'ok');
  assert.equal(reads.get('live')?.query, 'exceptions | summarize');
  assert.equal(reads.get('staging')?.status, 'ok');
  assert.deepEqual(
    system.store.appErrors.listGroups().map((g) => [g.environment, g.fingerprint]),
    [['live', 'Orders.Submit']],
  );
  const [call] = asked().filter(([slot]) => slot === 'appErrors');
  assert.equal(call?.[1].environment, 'live');
  assert.equal(typeof call?.[1].since, 'string');
  assert.deepEqual(
    reader.asked.map((r) => r.environment),
    ['staging'],
  );
});

test('an extension that fails the errors read is unknown, never "no errors", and the next read reaches back', async () => {
  const { system, logged } = await bench(throwing('appErrors'), [ERRORS_EXT]);
  await system.harness.runCycle();
  const [read] = system.store.appErrors.listReads();
  assert.equal(read?.status, 'unknown');
  assert.equal(read?.okAt, null);
  assert.match(read?.detail ?? '', /failed the "appErrors" slot/);
  assert.ok(logged.some((m) => /the telemetry API said 503/.test(m)));
});

test('an errors answer that is not a report is unknown', async () => {
  const { system } = await bench(
    `export default { apiVersion: 1, name: 'acme', slots: { appErrors: () => 'none' } };`,
    [ERRORS_EXT],
  );
  await system.harness.runCycle();
  assert.equal(system.store.appErrors.listReads()[0]?.status, 'unknown');
});

test('the detail query is the extension’s where it fills appErrorDetail, and none where it does not', async () => {
  const detailFor = async (source: string) => {
    const repoRoot = gitRepo();
    writeFileSync(join(repoRoot, 'ext.mjs'), source);
    const loaded = await loadExtensions({ paths: [join(repoRoot, 'ext.mjs')], book: EXTENSION_SLOTS });
    const host = buildExtensionHost({ repoRoot } as never, loaded, { record: () => {} } as never);
    const commands = new FakeAppErrorDetailRunner({ staging: 'from the command' });
    return new RoutedAppErrorDetail(
      [ERRORS_EXT, { ...ERRORS_CMD, errors: { list: './e.sh {since}', detail: './d.sh' } }],
      host,
      commands,
      new ExtensionAppErrorDetailRunner(host),
    );
  };
  asked();
  const both = await detailFor(RECORDING);
  assert.equal(both.command('live'), 'the "appErrorDetail" slot');
  assert.equal(both.command('staging'), './d.sh');
  const out = await both.detail({ environment: 'live', command: '', fingerprint: 'fp', since: 'then' });
  assert.deepEqual(out, { ok: true, text: 'the stack', truncated: false });
  assert.deepEqual(asked(), [['appErrorDetail', { environment: 'live', fingerprint: 'fp', since: 'then' }]]);
  const fromCommand = await both.detail({ environment: 'staging', command: './d.sh', fingerprint: 'fp', since: 'x' });
  assert.equal(fromCommand.ok && fromCommand.text, 'from the command');

  const listOnly = await detailFor(`export default { apiVersion: 1, name: 'acme', slots: { appErrors: () => [] } };`);
  assert.equal(listOnly.command('live'), null, 'appErrorDetail is optional, as errors.detail is');
});

// — the watch —

const WATCH_EXT: EnvironmentConfig = {
  name: 'live',
  at: './scripts/sha.sh',
  watch: { extension: true, forMs: 48 * HOUR, exposure: { atLeast: 0.9 } },
};

const SIGNAL: GoalWatchInput = {
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: "traces | where timestamp > datetime({since}) | where message has 'job X timed out'",
  presence: "traces | where timestamp > datetime({since}) | where operation_Name == 'job X'",
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
  source: null,
};

function arrived(system: System): void {
  system.store.watches.ingestGoalWatch('issue:12', [SIGNAL]);
  system.store.environments.recordGoalLanding({ prNumber: 4, goalRef: 'issue:12', sha: 'abc', mergedAt: null });
  system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'live',
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

test('the extension answers the watch: exposure first, then the prepared query, held to the id echo', async () => {
  asked();
  const { system, observer } = await bench(RECORDING, [WATCH_EXT]);
  arrived(system);
  await system.harness.runCycle();

  const calls = asked().filter(([slot]) => slot.startsWith('watch'));
  assert.deepEqual(calls[0], ['watchExposure', { environment: 'live', commits: ['abc'] }]);
  const [, presence] = calls[1]!;
  assert.equal(presence.kind, 'presence');
  assert.equal(presence.source, 'logs', 'with no sources, the extension answers one kql source named logs');
  assert.equal(presence.language, 'kql');
  assert.deepEqual(presence.commits, ['abc']);
  assert.doesNotMatch(String(presence.query), /\{since\}/);
  assert.match(String(presence.query), /\| extend lubbdubbWatchId = "no-timeouts"/);
  assert.equal(calls[2]?.[1].kind, 'signal');
  assert.equal(system.store.watches.listWatchReadings().at(-1)?.verdict, 'clean');
  assert.deepEqual(observer.asked, [], 'no command runs for the environment the extension answers');
});

test('the dry run asks the extension for its sources, unscoped, and never for a source a person runs', async () => {
  asked();
  const { system } = await bench(RECORDING, [
    {
      name: 'live',
      at: './scripts/sha.sh',
      watch: {
        extension: true,
        sources: { logs: { language: 'kql', runBy: 'harness' }, sql: { language: 'sql', runBy: 'operator' } },
      },
    },
  ]);
  system.store.watches.ingestGoalWatch('issue:12', [
    { ...SIGNAL, source: 'logs' },
    { ...SIGNAL, id: 'by-hand', seq: 2, source: 'sql', query: 'select * from t where at > {since}', presence: null },
  ]);
  await system.watch.run('issue:12');

  const calls = asked().filter(([slot]) => slot === 'watchReading');
  assert.deepEqual(
    calls.map(([, input]) => [input.checkId, input.source, input.commits]),
    [
      ['no-timeouts', 'logs', null],
      ['no-timeouts', 'logs', null],
    ],
  );
});

test('rows that do not carry the check’s id are not an answer', async () => {
  const { system } = await bench(
    `export default { apiVersion: 1, name: 'acme', slots: {
      watchReading: () => [{ runs: 96 }], watchExposure: () => ({ share: 1 }),
    } };`,
    [WATCH_EXT],
  );
  arrived(system);
  await system.harness.runCycle();
  const reading = system.store.watches.listWatchReadings().at(-1);
  assert.equal(reading?.verdict, 'unknown');
  assert.match(reading?.detail ?? '', /the extension answered without the query it was given/);
});

test('an extension that fails a watch reading is unknown, never clean', async () => {
  const { system, logged } = await bench(throwing('watchReading', 'watchExposure: () => ({ share: 1 }),'), [WATCH_EXT]);
  arrived(system);
  await system.harness.runCycle();
  const reading = system.store.watches.listWatchReadings().at(-1);
  assert.equal(reading?.verdict, 'unknown');
  assert.ok(logged.some((m) => /failed the "watchReading" slot/.test(m)));
});

test('an exposure the extension cannot give holds the window unread', async () => {
  const { system } = await bench(throwing('watchExposure', 'watchReading: () => [],'), [WATCH_EXT]);
  arrived(system);
  await system.harness.runCycle();
  const reading = system.store.watches.listWatchReadings().at(-1);
  assert.equal(reading?.verdict, 'unknown');
  assert.match(reading?.detail ?? '', /could not tell how much of live runs this change/);
  assert.equal(system.store.watches.listWatchWindows()[0]?.exposedAt, null);
});

test('an environment that watches by command keeps it while an extension is loaded', async () => {
  asked();
  const observer = await bench(RECORDING, [
    { name: 'staging', at: './scripts/sha.sh', watch: { observe: './scripts/telemetry.sh', forMs: 48 * HOUR } },
  ]);
  observer.system.store.watches.ingestGoalWatch('issue:12', [SIGNAL]);
  observer.system.store.environments.recordGoalLanding({ prNumber: 4, goalRef: 'issue:12', sha: 'a', mergedAt: null });
  observer.system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'staging',
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await observer.system.harness.runCycle();
  assert.equal(observer.observer.asked[0]?.environment, 'staging');
  assert.deepEqual(
    asked().filter(([slot]) => slot.startsWith('watch')),
    [],
  );
});

test('with no extension configured, every reading’s command path is unchanged', async () => {
  const { system, prober, reader } = await bench(null, [{ ...AT_CMD, errors: { list: './e.sh {since}' } }]);
  await system.harness.runCycle();
  assert.deepEqual(prober.asked, ['staging']);
  assert.deepEqual(
    reader.asked.map((r) => r.command.startsWith('./e.sh ')),
    [true],
  );
});

// — refusals —

test('an environment that hands a reading to the extension refuses to build without one that fills it', async () => {
  await assert.rejects(bench(null, [AT_EXT]), /"live" set "atExtension" and no extension fills the "deployedCommits"/);
  await assert.rejects(bench(null, [ERRORS_EXT]), /set "errors.extension" and no extension fills the "appErrors"/);
  await assert.rejects(
    bench(`export default { apiVersion: 1, name: 'acme', slots: { watchReading: () => [] } };`, [WATCH_EXT]),
    /set "watch.extension" and no extension fills the "watchExposure"/,
  );
});

test('a reading key beside the command it replaces is refused', () => {
  const load = (environment: object) => () =>
    loadConfig({ dbPath: ':memory:', repoRoot: gitRepo(), environments: [{ name: 'live', ...environment }] } as never);
  assert.throws(load({ at: './sha.sh', atExtension: true }), /"at" and "atExtension" are two answers/);
  assert.throws(load({ atExtension: 'yes' }), /"atExtension" must be true/);
  assert.throws(
    load({ atExtension: true, errors: { extension: true, list: './e.sh {since}' } }),
    /beside "errors.list"/,
  );
  assert.throws(load({ atExtension: true, errors: { extension: true, detail: './d.sh' } }), /beside "errors.detail"/);
  assert.throws(load({ atExtension: true, watch: { extension: true, observe: './t.sh' } }), /beside "watch.observe"/);
  assert.throws(
    load({
      atExtension: true,
      watch: { extension: true, sources: { logs: { language: 'kql', runBy: 'harness', observe: './t.sh' } } },
    }),
    /beside "watch.sources.logs.observe"/,
  );
  assert.throws(
    load({ atExtension: true, watch: { extension: true, exposure: { command: './x.sh' } } }),
    /beside "watch.exposure.command"/,
  );
  assert.throws(load({}), /"at" must be a non-empty command/, 'neither is still refused, in the old words');
});
