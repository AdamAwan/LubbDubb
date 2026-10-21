import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorsCommand, MAX_ROWS_PER_READ, parseAppErrorReport } from '../src/appErrors/report.js';
import { CommandAppErrorReader } from '../src/appErrors/reader.js';
import { appErrorKey, appErrorProject } from '../src/appErrors/key.js';
import {
  MAX_LOOKBACK_MS,
  QUIET_MS,
  mergeGroup,
  readSince,
  retainedDays,
  spreadCounts,
} from '../src/appErrors/groups.js';
import { DAY_MS } from '../src/primitives.js';
import { Store } from '../src/store/store.js';
import { appErrorState, BASELINE_DAYS, type AppErrorStateInput } from '../src/appErrors/states.js';
import { loadConfig } from '../src/config/config.js';
import type { AppErrorDay } from '../src/types.js';

const ROW = {
  fingerprint: 'System.NullReferenceException at OrderService.Submit',
  title: 'NullReferenceException in OrderService.Submit',
  count: 42,
  firstSeen: '2026-10-19T10:00:00Z',
  lastSeen: '2026-10-19T11:00:00Z',
  version: '2026.10.14.3',
  operation: 'POST /orders',
  frames: ['src/Orders/OrderService.cs:118'],
  message: 'Object reference not set to an instance of an object.',
  stack: 'at OrderService.Submit() in src/Orders/OrderService.cs:118\nat OrdersController.Post()',
  link: 'https://portal.azure.com/x',
};

test('a well-formed report is read row by row, with the link carried as the url', () => {
  const report = parseAppErrorReport(JSON.stringify([ROW]));
  assert.equal(report.status, 'ok');
  if (report.status !== 'ok') return;
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.rows, [
    {
      fingerprint: ROW.fingerprint,
      title: ROW.title,
      count: 42,
      firstSeen: '2026-10-19T10:00:00.000Z',
      lastSeen: '2026-10-19T11:00:00.000Z',
      version: ROW.version,
      operation: ROW.operation,
      frames: ROW.frames,
      message: ROW.message,
      stack: ROW.stack,
      url: ROW.link,
    },
  ]);
});

test('an empty list is no errors; silence, prose and the wrong shape are unknown', () => {
  const none = parseAppErrorReport('[]');
  assert.deepEqual(none, { status: 'ok', rows: [], refused: [], dropped: 0 });
  for (const [stdout, why] of [
    ['', /printed nothing/],
    ['not json', /did not answer with JSON/],
    ['{"errors": []}', /other than a list/],
    [JSON.stringify([{ title: 'x' }]), /every row .* was refused/],
  ] as const) {
    const report = parseAppErrorReport(stdout);
    assert.equal(report.status, 'unknown', stdout);
    if (report.status === 'unknown') assert.match(report.detail, why, stdout);
  }
});

test('a malformed row is refused and named, and the rest of the report still reads', () => {
  const bad = [
    { ...ROW, fingerprint: '' },
    { ...ROW, fingerprint: 'b', count: 0 },
    { ...ROW, fingerprint: 'c', count: 1.5 },
    { ...ROW, fingerprint: 'd', firstSeen: 'yesterday' },
    { ...ROW, fingerprint: 'e', firstSeen: ROW.lastSeen, lastSeen: ROW.firstSeen },
    { ...ROW, fingerprint: 'f', frames: 'src/a.cs' },
    { ...ROW, fingerprint: 'g', link: 'javascript:alert(1)' },
    { ...ROW, fingerprint: 'h', version: 7 },
    { ...ROW, fingerprint: 'x'.repeat(201) },
    'a string',
  ];
  const report = parseAppErrorReport(JSON.stringify([...bad, ROW]));
  assert.equal(report.status, 'ok');
  if (report.status !== 'ok') return;
  assert.equal(report.rows.length, 1);
  assert.equal(report.refused.length, bad.length);
  assert.match(report.refused[0] ?? '', /^row 0: "fingerprint"/);
});

test('one fingerprint printed twice is one group, its counts summed and its span widened', () => {
  const report = parseAppErrorReport(
    JSON.stringify([
      { ...ROW, count: 2, firstSeen: '2026-10-19T09:00:00Z', lastSeen: '2026-10-19T10:00:00Z', version: 'old' },
      { ...ROW, count: 3, version: 'new' },
    ]),
  );
  assert.equal(report.status, 'ok');
  if (report.status !== 'ok') return;
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]?.count, 5);
  assert.equal(report.rows[0]?.firstSeen, '2026-10-19T09:00:00.000Z');
  assert.equal(report.rows[0]?.version, 'new');
});

test('a report is bounded to the most frequent groups, and says how many it left out', () => {
  const rows = Array.from({ length: MAX_ROWS_PER_READ + 5 }, (_, i) => ({
    ...ROW,
    fingerprint: `f${String(i)}`,
    count: i + 1,
  }));
  const report = parseAppErrorReport(JSON.stringify(rows));
  assert.equal(report.status, 'ok');
  if (report.status !== 'ok') return;
  assert.equal(report.rows.length, MAX_ROWS_PER_READ);
  assert.equal(report.dropped, 5);
  assert.equal(report.rows[0]?.count, MAX_ROWS_PER_READ + 5);
});

test('{since} is substituted everywhere it appears', () => {
  assert.equal(errorsCommand('./e.sh live {since} {since}', 'T'), './e.sh live T T');
});

test('a command that fails is unknown however much it printed', async () => {
  const reader = new CommandAppErrorReader(process.cwd(), 10_000);
  const request = (command: string) => ({ environment: 'test', command, since: '2026-10-19T00:00:00.000Z' });

  const fine = await reader.list(request(`node -e "console.log(JSON.stringify([]))"`));
  assert.equal(fine.status, 'ok');

  const sinceSeen = await reader.list(
    request(`node -e "console.log(JSON.stringify(process.env.LUBBDUBB_ERRORS_SINCE))"`),
  );
  assert.equal(sinceSeen.status, 'unknown', 'a string is not a list — and the variable reached the command');

  const failed = await reader.list(request(`node -e "console.log('[]'); console.error('no login'); process.exit(2)"`));
  assert.equal(failed.status, 'unknown', 'an empty list from a command that failed is not "no errors"');
  if (failed.status === 'unknown') assert.match(failed.detail, /exited 2: no login/);

  const missing = await reader.list(request('definitely-not-a-real-binary-xyz {since}'));
  assert.equal(missing.status, 'unknown');
});

test('the key is short, stable, scoped by project and carries no fingerprint text', () => {
  const key = appErrorKey('acme-api', ROW.fingerprint);
  assert.match(key, /^err:acme-api:[0-9a-f]{8}$/);
  assert.equal(key, appErrorKey('acme-api', ROW.fingerprint));
  assert.notEqual(key, appErrorKey('acme-api', `${ROW.fingerprint} `));
  assert.notEqual(key.slice(-8), appErrorKey('acme-api', 'other').slice(-8));
  assert.ok(!key.includes('Order'));
});

test('the project is the pool project, then the repository, slugged', () => {
  const base = loadConfig({ repoRoot: '/tmp/Some Repo' });
  assert.equal(appErrorProject({ ...base, pool: { project: 'Acme API' } }), 'acme-api');
  assert.equal(appErrorProject({ ...base, pool: {}, github: { owner: 'o', repo: 'Shop' } }), 'shop');
  assert.equal(appErrorProject({ ...base, pool: { project: '' } }), 'some-repo');
});

const NOW = Date.parse('2026-10-20T12:00:00.000Z');

test('{since} is the last answered read, never further back than the lookback', () => {
  assert.equal(readSince(null, NOW), new Date(NOW - MAX_LOOKBACK_MS).toISOString());
  assert.equal(readSince('2026-10-20T11:00:00.000Z', NOW), '2026-10-20T11:00:00.000Z');
  assert.equal(readSince('2026-01-01T00:00:00.000Z', NOW), new Date(NOW - MAX_LOOKBACK_MS).toISOString());
});

test('a count is spread over the days it spans inside the read', () => {
  const row = {
    ...ROW,
    url: null,
    count: 10,
    firstSeen: '2026-10-17T10:00:00.000Z',
    lastSeen: '2026-10-19T10:00:00.000Z',
  };
  const spread = spreadCounts({ ...row, version: null, operation: null, frames: [] }, '2026-10-18T00:00:00.000Z');
  assert.deepEqual(spread, [
    { day: '2026-10-18', count: 5 },
    { day: '2026-10-19', count: 5 },
  ]);
  const odd = spreadCounts(
    { ...row, version: null, operation: null, frames: [], count: 3 },
    '2026-10-01T00:00:00.000Z',
  );
  assert.deepEqual(
    odd.map((d) => d.count),
    [1, 1, 1],
  );
});

test('a group seen again after a quiet gap is marked returned; one seen steadily is not', () => {
  const row = {
    ...ROW,
    url: null,
    version: null,
    operation: null,
    frames: [],
    firstSeen: '2026-10-20T10:00:00.000Z',
    lastSeen: '2026-10-20T11:00:00.000Z',
  };
  const held = mergeGroup(undefined, 'live', {
    ...row,
    firstSeen: '2026-10-01T00:00:00.000Z',
    lastSeen: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(held.returnedAt, null);
  const back = mergeGroup(held, 'live', row);
  assert.equal(back.returnedAt, row.firstSeen);
  assert.equal(back.firstSeen, '2026-10-01T00:00:00.000Z');
  assert.equal(back.lastSeen, row.lastSeen);
  const steady = mergeGroup(
    { ...held, lastSeen: new Date(Date.parse(row.firstSeen) - QUIET_MS + 1).toISOString() },
    'live',
    row,
  );
  assert.equal(steady.returnedAt, null);
});

test('the head moves only when the probe names another, and the first head is no deploy', () => {
  const store = new Store(':memory:');
  const env = store.environments;
  assert.equal(env.getEnvironmentHead('live'), null);
  env.recordEnvironmentHead('live', 'aaa');
  assert.deepEqual(
    { ...env.getEnvironmentHead('live'), observedAt: null },
    { environment: 'live', sha: 'aaa', previousSha: null, observedAt: null, changedAt: null },
  );
  env.recordEnvironmentHead('live', 'aaa');
  assert.equal(env.getEnvironmentHead('live')?.changedAt, null, 'the same head again is no deploy');
  env.recordEnvironmentHead('live', 'bbb');
  const moved = env.getEnvironmentHead('live');
  assert.equal(moved?.sha, 'bbb');
  assert.equal(moved?.previousSha, 'aaa');
  assert.equal(moved?.changedAt, moved?.observedAt, 'a head that moved is a deploy, noticed now');
  env.recordEnvironmentHead('live', 'bbb');
  assert.equal(env.getEnvironmentHead('live')?.previousSha, 'aaa');
  store.close();
});

test('the retained window is the last fortnight of UTC days, today included', () => {
  const window = retainedDays(NOW);
  assert.equal(window.length, 14);
  assert.equal(window[13], '2026-10-20');
  assert.equal(window[0], '2026-10-07');
});

function days(counts: Record<string, number>): AppErrorDay[] {
  return Object.entries(counts).map(([day, count]) => ({ day, count }));
}

type GroupOver = Partial<AppErrorStateInput['group']>;

function state(over: Partial<Omit<AppErrorStateInput, 'group'>> & { group?: GroupOver } = {}) {
  const { group, ...rest } = over;
  return appErrorState({
    deployedAt: '2026-10-19T00:00:00.000Z',
    now: NOW,
    minCount: 2,
    ignored: false,
    ...rest,
    group: {
      firstSeen: '2026-10-10T00:00:00.000Z',
      lastSeen: '2026-10-20T11:00:00.000Z',
      returnedAt: null,
      daily: days({ '2026-10-13': 5, '2026-10-15': 5, '2026-10-16': 5, '2026-10-19': 3, '2026-10-20': 3 }),
      ...group,
    },
  });
}

test('a group seen at its usual rate is steady', () => {
  assert.equal(state(), 'steady');
});

test('a group first seen after the deploy is new — unless it is below the minimum, or ignored', () => {
  const fresh = { firstSeen: '2026-10-19T06:00:00.000Z', daily: days({ '2026-10-19': 5 }) };
  assert.equal(state({ group: fresh }), 'new');
  assert.equal(state({ group: { ...fresh, daily: days({ '2026-10-19': 1 }) } }), 'steady');
  assert.equal(state({ group: fresh, ignored: true }), 'steady');
});

test('with no deploy on record, new means first seen within the last day', () => {
  assert.equal(state({ deployedAt: null, group: { firstSeen: '2026-10-20T01:00:00.000Z' } }), 'new');
  assert.equal(state({ deployedAt: null, group: { firstSeen: '2026-10-12T01:00:00.000Z' } }), 'steady');
});

test('a group not seen for the quiet period is gone, whatever else is true of it', () => {
  const stale = new Date(NOW - QUIET_MS - 1).toISOString();
  assert.equal(state({ group: { lastSeen: stale } }), 'gone');
  assert.equal(state({ group: { lastSeen: stale, firstSeen: '2026-10-19T06:00:00.000Z' } }), 'gone');
});

test('a group that came back recently reads returned', () => {
  assert.equal(state({ group: { returnedAt: '2026-10-20T10:00:00.000Z' } }), 'returned');
  assert.equal(state({ group: { returnedAt: new Date(NOW - QUIET_MS - 1).toISOString() } }), 'steady');
});

test('a group running well above its pre-deploy baseline is spiking', () => {
  const baseline: Record<string, number> = {};
  for (let i = 1; i <= BASELINE_DAYS; i++)
    baseline[new Date(Date.parse('2026-10-19') - i * DAY_MS).toISOString().slice(0, 10)] = 2;
  assert.equal(state({ group: { daily: days({ ...baseline, '2026-10-19': 30, '2026-10-20': 30 }) } }), 'spiking');
  assert.equal(state({ group: { daily: days({ ...baseline, '2026-10-19': 3, '2026-10-20': 3 }) } }), 'steady');
  assert.equal(
    state({ group: { daily: days({ ...baseline, '2026-10-19': 30 }) }, ignored: true }),
    'steady',
    'an ignored group never moves',
  );
});

test('the payload carries whether a group has a message or stack, never the text itself', () => {
  const store = new Store(':memory:');
  const group = {
    environment: 'live',
    fingerprint: 'fp',
    title: 't',
    operation: null,
    version: null,
    frames: [],
    url: null,
    firstSeen: '2026-10-20T08:00:00.000Z',
    lastSeen: '2026-10-20T09:00:00.000Z',
    returnedAt: null,
  };
  store.appErrors.recordRead({ environment: 'live', status: 'ok', detail: null, readAt: '2026-10-20T10:00:00.000Z' }, [
    { group: { ...group, message: 'boom', stack: 'at x()' }, days: [] },
    { group: { ...group, fingerprint: 'bare', message: null, stack: null }, days: [] },
  ]);
  const listed = store.appErrors.listGroups();
  assert.deepEqual(
    new Map(listed.map((g) => [g.fingerprint, g.hasDetail])),
    new Map([
      ['fp', true],
      ['bare', false],
    ]),
  );
  assert.ok(listed.every((g) => !('stack' in g) && !('message' in g)));
  assert.deepEqual(store.appErrors.getDetail('live', 'fp'), { message: 'boom', stack: 'at x()' });
  assert.equal(store.appErrors.getDetail('live', 'nope'), null);
});
