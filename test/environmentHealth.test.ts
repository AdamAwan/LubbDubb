import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { parseHealthReport } from '../src/environments/health.js';
import { CommandEnvironmentHealthProber } from '../src/environments/healthProber.js';
import { FakeEnvironmentHealthProber } from '../src/environments/fakeHealthProber.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';

// --- the output contract ---------------------------------------------------

test('a healthy report is read as healthy, with no tier and nothing to say', () => {
  const report = parseHealthReport('{ "state": "Healthy" }');
  assert.deepEqual(report, { state: 'healthy', tier: null, reasons: [], detail: null });
});

test('an unhealthy report carries its tier and its own sentences', () => {
  const report = parseHealthReport(
    JSON.stringify({ state: 'NotHealthy', tier: 'Red', reasons: ['Pipeline failing', 'Solr down'] }),
  );
  assert.deepEqual(report, {
    state: 'unhealthy',
    tier: 'red',
    reasons: ['Pipeline failing', 'Solr down'],
    detail: null,
  });
});

test('the state vocabulary is generous on the way in and closed on the way out', () => {
  // This contract is written once, from an example, so case and punctuation are
  // not the thing a fleet's health reading is allowed to turn on.
  for (const word of ['Healthy', 'healthy', 'HEALTHY', 'ok'])
    assert.equal(parseHealthReport(`{"state":"${word}"}`).state, 'healthy', word);
  for (const word of ['NotHealthy', 'not-healthy', 'not healthy', 'unhealthy'])
    assert.equal(parseHealthReport(`{"state":"${word}"}`).state, 'unhealthy', word);
  // A check that knows it cannot tell says so, and keeps its own account of why.
  const cannot = parseHealthReport('{"state":"Unknown","reasons":["the credential expired"]}');
  assert.deepEqual(cannot, {
    state: 'unknown',
    tier: null,
    reasons: ['the credential expired'],
    detail: null,
  });
});

test('an untiered unhealthy report is still unhealthy', () => {
  // The state is the signal and the tier is the detail. Refusing this would turn a
  // real outage into `unknown` on a script that simply says the thing that matters.
  const report = parseHealthReport('{"state":"NotHealthy","reasons":["Solr down"]}');
  assert.equal(report.state, 'unhealthy');
  assert.equal(report.tier, null);
});

test('every unreadable answer lands on unknown, and says why', () => {
  const cases: [string, RegExp][] = [
    ['', /printed nothing/],
    ['   ', /printed nothing/],
    ['not json at all', /did not answer with JSON/],
    ['[{"state":"Healthy"}]', /other than a \{"state"/],
    ['{"state":"Fine"}', /named no state/],
    ['{}', /named no state/],
    ['{"state":"NotHealthy","tier":"Puce"}', /"tier" must be red or orange/],
    ['{"state":"NotHealthy","reasons":"Solr down"}', /"reasons" must be a list/],
    // A healthy report carrying a tier is a script with a bug in it, and the two
    // halves disagree about the only thing the reading is for.
    ['{"state":"Healthy","tier":"Red"}', /carries no tier/],
  ];
  for (const [stdout, why] of cases) {
    const report = parseHealthReport(stdout);
    assert.equal(report.state, 'unknown', stdout);
    assert.equal(report.tier, null, stdout);
    assert.match(report.detail ?? '', why, stdout);
  }
});

test('the reason list is bounded, and non-sentences are dropped from it', () => {
  const reasons = [...Array(30).keys()].map((i) => `reason ${String(i)}`);
  const many = parseHealthReport(JSON.stringify({ state: 'NotHealthy', tier: 'orange', reasons }));
  assert.equal(many.reasons.length, 12, 'a row is a reading, not a log');
  const messy = parseHealthReport(
    JSON.stringify({ state: 'NotHealthy', tier: 'orange', reasons: ['  Solr down  ', '', 7, null] }),
  );
  assert.deepEqual(messy.reasons, ['Solr down']);
  const long = parseHealthReport(JSON.stringify({ state: 'NotHealthy', reasons: ['x'.repeat(500)] }));
  assert.equal(long.reasons[0]?.length, 200, 'a stack trace pasted into the list is not a reason');
});

// --- the command -----------------------------------------------------------

test('the report is read from stdout whatever the exit code', async () => {
  const prober = new CommandEnvironmentHealthProber(process.cwd(), 10_000);

  const well = await prober.check('prod', 'node -e "console.log(JSON.stringify({state:\'Healthy\'}))"');
  assert.deepEqual(well, { state: 'healthy', tier: null, reasons: [], detail: null });

  // The shape half the world already writes: `set -e`, a `curl -f`, a pipeline
  // task's own convention. Refusing it would turn every real outage into
  // `unknown` on exactly the deployments whose script works.
  const ill = await prober.check(
    'prod',
    "node -e \"console.log(JSON.stringify({state:'NotHealthy',tier:'Red',reasons:['Solr down']})); process.exit(1)\"",
  );
  assert.equal(ill.state, 'unhealthy');
  assert.equal(ill.tier, 'red');
  assert.deepEqual(ill.reasons, ['Solr down']);

  // Only when stdout said nothing readable does the exit code become the
  // explanation — and then it is the better account of the silence.
  const broken = await prober.check('prod', 'node -e "console.error(\'no kubeconfig\'); process.exit(3)"');
  assert.equal(broken.state, 'unknown');
  assert.match(broken.detail ?? '', /exited 3/);
  assert.match(broken.detail ?? '', /no kubeconfig/);

  const missing = await prober.check('prod', 'definitely-not-a-real-binary-xyz');
  assert.equal(missing.state, 'unknown', 'a command that does not exist has not said the environment is well');
});

// --- the whole system ------------------------------------------------------

/** A system with environments configured and a scripted health check — no shell, no network. */
function build(environments: EnvironmentConfig[], healthProber: FakeEnvironmentHealthProber, healthIntervalMs = 0) {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    dbPath: ':memory:',
    heartbeatIntervalMs: 60_000,
    environments,
    environmentProbeIntervalMs: 0,
    environmentHealthIntervalMs: healthIntervalMs,
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentHealthProber: healthProber,
  });
}

const HEALTHY = JSON.stringify({ state: 'Healthy' });
const ILL = JSON.stringify({ state: 'NotHealthy', tier: 'Orange', reasons: ['Pipeline failing'] });

test('only an environment that declares a health check is asked, and its answer is written down', async () => {
  const prober = new FakeEnvironmentHealthProber({ testUk: HEALTHY, liveUk: ILL });
  const system = build(
    [
      { name: 'testUk', at: 'unused', health: 'unused' },
      { name: 'liveUk', at: 'unused', health: 'unused' },
      // Declares none: observed for reach and nothing more. A row of question
      // marks here would be the feature announcing itself as broken.
      { name: 'liveEu', at: 'unused' },
    ],
    prober,
  );

  await system.harness.runCycle();

  assert.deepEqual(prober.asked, ['testUk', 'liveUk']);
  const readings = system.store.listEnvironmentHealth();
  assert.deepEqual(
    readings.map((r) => [r.environment, r.state, r.tier, r.reasons.join()]),
    [
      ['testUk', 'healthy', null, ''],
      ['liveUk', 'unhealthy', 'orange', 'Pipeline failing'],
    ],
  );
});

test('a check that cannot answer is written down as unknown, never as well', async () => {
  // The whole reason the state is three-valued: an expired credential and a
  // healthy environment must not read the same, in either direction.
  const system = build([{ name: 'testUk', at: 'unused', health: 'unused' }], new FakeEnvironmentHealthProber());

  await system.harness.runCycle();

  const reading = system.store.listEnvironmentHealth()[0];
  assert.equal(reading?.state, 'unknown');
  assert.equal(reading?.detail, 'unscripted');
});

test('a health reading stands for its interval, and an episode keeps its start', async () => {
  const prober = new FakeEnvironmentHealthProber({ testUk: ILL });
  const system = build([{ name: 'testUk', at: 'unused', health: 'unused' }], prober, 60 * 60 * 1000);

  await system.harness.runCycle();
  await system.harness.runCycle();
  assert.deepEqual(prober.asked, ['testUk'], 'a standing reading inside the interval is not re-asked');

  const first = system.store.listEnvironmentHealth()[0];
  assert.ok(first);
  // The same answer again does not restart the clock: a check whose reason list
  // shifts while an outage runs is the same outage, and a `since` restarting
  // under it every five minutes would report a fresh one forever.
  system.store.recordEnvironmentHealth({
    environment: 'testUk',
    state: 'unhealthy',
    tier: 'orange',
    reasons: ['Pipeline failing', 'and now Solr'],
    detail: null,
  });
  const same = system.store.listEnvironmentHealth()[0];
  assert.equal(same?.changedAt, first.changedAt, 'still the same episode');
  assert.deepEqual(same?.reasons, ['Pipeline failing', 'and now Solr'], 'but the newest account of it');

  system.store.recordEnvironmentHealth({
    environment: 'testUk',
    state: 'unhealthy',
    tier: 'red',
    reasons: [],
    detail: null,
  });
  const worse = system.store.listEnvironmentHealth()[0];
  assert.notEqual(worse?.changedAt, first.changedAt, 'a change of tier is a new episode');
});

test('the cockpit is shipped the environments that declare a check today, in the operator’s order', async () => {
  const prober = new FakeEnvironmentHealthProber({ testUk: HEALTHY, liveUk: ILL });
  const system = build(
    [
      { name: 'liveUk', at: 'unused', health: 'unused' },
      { name: 'testUk', at: 'unused', health: 'unused' },
    ],
    prober,
  );
  await system.harness.runCycle();
  assert.deepEqual(
    buildStateSnapshot(system).environmentHealth.map((r) => r.environment),
    ['liveUk', 'testUk'],
    'the operator’s list is the order the work travels in, and the order it is drawn in',
  );

  // Nothing deletes a stored reading, so the configuration is what says whether
  // the question is still being asked — otherwise a removed check would be drawn
  // with its last answer for ever.
  const after = build([{ name: 'liveUk', at: 'unused' }], new FakeEnvironmentHealthProber());
  assert.deepEqual(buildStateSnapshot(after).environmentHealth, [], 'no check declared, no health surface at all');
});

test('an empty health command is refused rather than left to answer nothing', () => {
  assert.throws(
    () => validateEnvironments([{ name: 'testUk', at: 'git rev-parse HEAD', health: '  ' }]),
    /"health" must be a non-empty command/,
  );
  // Left out entirely is the honest way to say the question is not asked here.
  validateEnvironments([{ name: 'testUk', at: 'git rev-parse HEAD' }]);
});
