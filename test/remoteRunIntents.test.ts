import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { commentSink } from './support/commentSink.js';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/validation/remote/desk.js';
import { RemoteRunDesk } from '../src/validation/remote/run.js';
import { RemoteIntentDesk } from '../src/validation/remote/intent.js';
import { StateQueryDesk } from '../src/validation/remote/stateQueries.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import { watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { RemoteRun, RemoteRunIntent, RemoteSheetRow, StateQueryInput } from '../src/types.js';
import { okable, okStanding, pageRows, sheetsAwaitingOk } from '../src/validation/remote/intent.js';
import { validationReadyPass } from '../src/validation/ready.js';
import { DESK_SETTLED } from '../src/benchSettlement.js';
import { arrivalSheetStep } from '../src/environments/watchWindow.js';

/*
 * The OK and the desk arm that presses it. → docs/spec/36-remote-validation.md#the-ok
 *
 * `FakeStateReader`, `FakeTenantKeeper` and `FakeEnvironmentProber` throughout: the defaults spawn the
 * project's own commands against a real environment.
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: { permits: ['state'], tenant: 'validation-customer-1', state: { run: './scripts/query.sh acceptance' } },
};

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

function bench(
  opts: {
    environments?: EnvironmentConfig[];
    env?: Record<string, string | undefined>;
    presence?: unknown[];
    accepted?: string[];
  } = {},
) {
  const environments = opts.environments ?? [ACCEPTANCE];
  const store = new Store(':memory:');
  const reader = new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify(opts.presence ?? [watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
  const git = new FakeGitObserver();
  git.setContains(DEPLOYED, LANDED, true);
  const desk = new RemoteValidationDesk({
    sink: commentSink(),
    validationRoot: join(tmpdir(), 'lubbdubb-no-captures'),
    store,
    environments,
    queries: new StateQueryDesk({ store, environments, reader }),
    scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
    probeIntervalMs: 60_000,
    now: () => NOW,
  });
  const runs = new RemoteRunDesk({
    store,
    environments,
    desk,
    prober: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
    git,
    tenants: new FakeTenantKeeper(),
    now: () => NOW,
    env: opts.env ?? {},
  });
  const intents = new RemoteIntentDesk({
    store,
    environments,
    desk,
    runs,
    proposals: {
      accept: async (id: string) => {
        opts.accepted?.push(id);
        return null;
      },
    },
  });
  const environment = environments[0]!;
  store.remoteValidation.saveStateQueries('issue:12', [QUERY], 'agent');
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: environment.name });
  store.remoteValidation.saveRemoteSheetRows(
    'issue:12',
    environment.name,
    desk.fold(environment, 'issue:12').map(({ run: _run, ...row }) => row),
  );
  return { store, desk, runs, intents, close: () => store.close() };
}

const intentOf = (store: Store) => store.remoteIntents.getIntent('issue:12', 'acceptance');

test('the OK approves what answered, and the next pulse presses it and reads the row', async () => {
  const b = bench();
  try {
    const given = await b.intents.give('issue:12', 'acceptance');
    assert.equal(given.ok, true);
    assert.deepEqual(given.ok && given.refused, []);
    assert.equal(intentOf(b.store)?.state, 'given');
    assert.equal(
      b.store.remoteValidation.listStateQueryApprovals().length,
      1,
      'the dry run answered, so it is approved',
    );

    await b.intents.run();

    const run = b.store.remoteValidation.listRemoteRuns()[0];
    assert.equal(intentOf(b.store)?.state, 'consumed');
    assert.equal(intentOf(b.store)?.runId, run?.id);
    assert.equal(
      b.store.remoteValidation.listRemoteReadings().find((r) => r.runId === run?.id)?.rowId,
      `state:${QUERY.id}`,
    );
  } finally {
    b.close();
  }
});

test('a query whose dry run does not answer is not approved, and the OK is still given', async () => {
  const b = bench({ presence: [] });
  try {
    const given = await b.intents.give('issue:12', 'acceptance');

    assert.equal(given.ok && given.refused[0]?.queryId, QUERY.id);
    assert.deepEqual(b.store.remoteValidation.listStateQueryApprovals(), []);
    assert.equal(intentOf(b.store)?.state, 'given', 'the rest of the page does not wait for it');
  } finally {
    b.close();
  }
});

test('a held lock queues the OK, and it runs once the lock frees', async () => {
  const b = bench();
  try {
    await b.intents.give('issue:12', 'acceptance');
    const other = b.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:398',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });

    await b.intents.run();
    assert.equal(intentOf(b.store)?.state, 'given');
    assert.match(intentOf(b.store)?.note ?? '', /queued behind the run for issue:398/);

    b.store.remoteValidation.endRemoteRun(other.run!.id, { status: 'ended' });
    await b.intents.run();
    assert.equal(intentOf(b.store)?.state, 'consumed');
  } finally {
    b.close();
  }
});

test('with no tenant the OK waits, naming the variable, and runs once one is supplied', async () => {
  const env: Record<string, string | undefined> = {};
  const FROM_ENV: EnvironmentConfig = {
    ...ACCEPTANCE,
    validate: { ...ACCEPTANCE.validate!, tenant: undefined, tenantEnv: 'VALIDATION_TENANT' },
  };
  const b = bench({ environments: [FROM_ENV], env });
  try {
    await b.intents.give('issue:12', 'acceptance');
    await b.intents.run();
    assert.equal(intentOf(b.store)?.state, 'given');
    assert.match(intentOf(b.store)?.note ?? '', /VALIDATION_TENANT/);
    assert.deepEqual(b.store.remoteValidation.listRemoteRuns(), [], 'and nothing was pressed while it waited');

    env['VALIDATION_TENANT'] = 'validation-customer-1';
    await b.intents.run();
    assert.equal(intentOf(b.store)?.state, 'consumed');
  } finally {
    b.close();
  }
});

test('an OK given over a page that has since changed is not pressed', async () => {
  const b = bench();
  try {
    await b.intents.give('issue:12', 'acceptance');
    b.store.remoteValidation.saveStateQueries('issue:12', [{ ...QUERY, query: `${QUERY.query} limit 10` }], 'agent');

    await b.intents.run();

    assert.equal(intentOf(b.store)?.state, 'withdrawn', 'the OK lapses, and the page asks again');
    assert.match(intentOf(b.store)?.note ?? '', /changed since the OK/);
    assert.deepEqual(b.store.remoteValidation.listRemoteRuns(), []);
  } finally {
    b.close();
  }
});

test('a withdrawn OK is not pressed, and an OK after a run is a run again', async () => {
  const b = bench();
  try {
    await b.intents.give('issue:12', 'acceptance');
    assert.equal(b.intents.withdraw('issue:12', 'acceptance')?.state, 'withdrawn');
    assert.equal(b.intents.withdraw('issue:12', 'acceptance'), null, 'there is nothing left to take back');
    await b.intents.run();
    assert.deepEqual(b.store.remoteValidation.listRemoteRuns(), []);

    await b.intents.give('issue:12', 'acceptance');
    await b.intents.run();
    await b.intents.give('issue:12', 'acceptance');
    await b.intents.run();
    assert.equal(b.store.remoteValidation.listRemoteRuns().length, 2);
  } finally {
    b.close();
  }
});

test('ship day: every sheet from before the table gets a consumed intent, once', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-intents-')), 'db.sqlite');
  const first = new Store(path);
  first.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
  first.close();
  const raw = new Database(path);
  raw.exec('DROP TABLE remote_run_intents');
  raw.close();

  const upgraded = new Store(path);
  assert.equal(upgraded.remoteIntents.getIntent('issue:12', 'acceptance')?.state, 'consumed');
  upgraded.remoteValidation.openRemoteSheet({ goalRef: 'issue:15', environment: 'acceptance' });
  upgraded.close();

  const later = new Store(path);
  assert.equal(later.remoteIntents.getIntent('issue:15', 'acceptance'), null, 'a later boot consumes nothing');
  later.close();
});

test('the OK accepts an authored set nobody has answered: through the card where one is pending', async () => {
  const accepted: string[] = [];
  const b = bench({ accepted });
  try {
    b.store.validation.recordValidationAuthoring('issue:12', { note: '', emptyReason: null });
    const pressed = await b.runs.press('issue:12', 'acceptance');
    assert.equal(!pressed.ok && pressed.code, 409, 'nothing runs on checks nobody accepted');

    const card = b.store.escalations.createProposal({
      kind: 'validation_plan',
      ref: 'issue:12:validate-plan',
      action: { type: 'noop' } as never,
      escalationId: null,
    });
    const given = await b.intents.give('issue:12', 'acceptance');
    assert.deepEqual(accepted, [card.id], 'the card’s own accept, so its proposal and escalation close');
    assert.equal(!given.ok && given.code, 409, 'a card that would not accept leaves no OK behind');
    assert.equal(intentOf(b.store), null);
  } finally {
    b.close();
  }
});

test('the OK approves only the queries on rows the page still selects', async () => {
  const b = bench();
  try {
    b.store.remoteValidation.setRemoteSheetRowSelected('issue:12', 'acceptance', `state:${QUERY.id}`, false);
    await b.intents.give('issue:12', 'acceptance');
    assert.deepEqual(b.store.remoteValidation.listStateQueryApprovals(), [], 'a row left out is not consented to');
  } finally {
    b.close();
  }
});

test('a check declined after the sheet was assembled is off the page, and asks nothing', () => {
  const row = sheetRow({ rowId: 'check:b', kind: 'check', sourceId: 'b' });
  const gone = new Set(['issue:12 b']);
  assert.deepEqual(pageRows([row], gone), []);
  assert.equal(
    sheetsAwaitingOk({ sheets: [SHEET], rows: [row], intents: [], runs: [], gone }).size,
    0,
    'a declined row does not hold the bench',
  );
});

test('the OK releases an authored set directly where no card was ever filed', async () => {
  const b = bench();
  try {
    b.store.validation.recordValidationAuthoring('issue:12', { note: '', emptyReason: null });
    await b.intents.give('issue:12', 'acceptance');
    assert.notEqual(b.store.validation.getValidationPlanRecord('issue:12')?.releasedAt, null);
    await b.intents.run();
    assert.equal(intentOf(b.store)?.state, 'consumed');
  } finally {
    b.close();
  }
});

test('not validating here records the operator’s reason and asks nothing more', () => {
  const b = bench();
  try {
    assert.equal(b.intents.notHere('issue:12', 'nowhere', 'no such sheet'), null);
    const marked = b.intents.notHere('issue:12', 'acceptance', 'acceptance is being rebuilt this week');
    assert.equal(marked?.state, 'not_here');
    assert.equal(marked?.note, 'acceptance is being rebuilt this week');
  } finally {
    b.close();
  }
});

const SHEET = { goalRef: 'issue:12', environment: 'acceptance', assembledAt: '2026-09-08T12:00:00.000Z' };

function sheetRow(over: Partial<RemoteSheetRow> = {}): RemoteSheetRow {
  return {
    goalRef: 'issue:12',
    environment: 'acceptance',
    rowId: `state:${QUERY.id}`,
    kind: 'state',
    seq: 1,
    title: QUERY.title,
    sourceId: QUERY.id,
    selected: true,
    blockedReason: null,
    awaitingApproval: false,
    matched: null,
    idleReason: null,
    ...over,
  };
}

function intent(state: RemoteRunIntent['state']): RemoteRunIntent {
  return {
    goalRef: 'issue:12',
    environment: 'acceptance',
    state,
    fingerprint: '',
    givenAt: SHEET.assembledAt,
    runId: null,
    note: null,
    updatedAt: SHEET.assembledAt,
  };
}

test('a page reads where it stands off its intent, its run and its rows to OK, once for the cockpit and the hold', () => {
  const RUN = { id: 'run_1', goalRef: 'issue:12', environment: 'acceptance', status: 'ended', note: null } as RemoteRun;
  const standing = (over: { rows?: RemoteSheetRow[]; intent?: RemoteRunIntent | null; run?: RemoteRun | null }) =>
    okStanding({ rows: [sheetRow()], intent: null, run: null, ...over });
  assert.equal(standing({}).status, 'needs-you', 'a row to OK and no OK');
  assert.equal(standing({ rows: [sheetRow({ selected: false })] }).status, 'nothing', 'nothing to OK asks nothing');
  assert.deepEqual(standing({ intent: { ...intent('given'), note: 'queued behind the run for issue:398.' } }), {
    status: 'queued',
    why: 'queued behind the run for issue:398.',
  });
  assert.equal(standing({ run: { ...RUN, status: 'dispatched' } }).status, 'running');
  assert.equal(standing({ run: RUN, intent: { ...intent('consumed'), runId: 'run_1' } }).status, 'done');
  assert.deepEqual(
    standing({
      run: { ...RUN, status: 'abandoned', note: 'gone back past this goal' },
      intent: { ...intent('consumed'), runId: 'run_1' },
    }),
    { status: 'needs-you', why: 'gone back past this goal' },
    'an abandoned run comes back to the operator, saying why',
  );
  assert.equal(standing({ intent: intent('consumed') }).status, 'open', 'ship day: answered, still runnable');
  assert.equal(standing({ intent: { ...intent('not_here'), note: 'rebuilt' } }).why, 'rebuilt');
  assert.equal(
    standing({ intent: { ...intent('withdrawn'), note: 'the page has changed' } }).why,
    'the page has changed',
  );

  assert.equal(okable(sheetRow({ blockedReason: 'not approved here', awaitingApproval: true })), true);
  assert.equal(okable(sheetRow({ blockedReason: 'does not permit state rows' })), false);
  assert.equal(okable(sheetRow({ idleReason: 'a person carries it' })), false);

  const awaiting = (intents: RemoteRunIntent[], runs: RemoteRun[] = []) =>
    sheetsAwaitingOk({ sheets: [SHEET], rows: [sheetRow()], intents, runs, gone: new Set() });
  assert.deepEqual([...awaiting([])], [['issue:12', ['acceptance']]]);
  assert.equal(awaiting([intent('given')]).size, 0);
  assert.equal(
    awaiting([{ ...intent('consumed'), runId: 'run_1' }], [{ ...RUN, status: 'abandoned' }]).size,
    1,
    'the hold reads the same standing the cockpit draws',
  );
});

test('the validate row is held open while a page awaits its OK, though no check is owed to a person', () => {
  const input = {
    issues: [],
    deliveries: [
      {
        originRef: 'issue:12',
        summary: 'PR #40 landed it',
        detail: null,
        by: 'assessor' as const,
        agentId: null,
        taskId: null,
        decidedAt: SHEET.assembledAt,
        updatedAt: SHEET.assembledAt,
      },
    ],
    shortfalls: [],
    existing: [],
    checks: new Map(),
    sheetRows: new Map(),
    opened: null,
    released: null,
    watchCleared: null,
    awaitingOk: new Map<string, string[]>(),
  };
  assert.deepEqual(validationReadyPass(input), [], 'nothing owed and nothing awaiting: no row');
  const held = validationReadyPass({ ...input, awaitingOk: new Map([['issue:12', ['acceptance']]]) });
  assert.equal(held[0]?.kind, 'file');
  assert.match(held[0]?.kind === 'file' ? held[0].detail : '', /on acceptance is waiting for your OK/);
  assert.doesNotMatch(
    held[0]?.kind === 'file' ? held[0].detail : '',
    /Run them/,
    'nothing to run by hand is asked for',
  );

  const settled = (status: 'done' | 'declined', resolution: string) =>
    ({ id: 't1', originRef: 'issue:12', kind: 'validate', status, resolution }) as never;
  const ask = (existing: never) =>
    validationReadyPass({ ...input, existing: [existing], awaitingOk: new Map([['issue:12', ['acceptance']]]) });
  assert.equal(
    ask(settled('done', `${DESK_SETTLED}every check is recorded`))[0]?.kind,
    'reopen',
    'a row the desk settled comes back when a page needs the OK again — a run the pin abandoned',
  );
  assert.deepEqual(ask(settled('done', 'marked by you')), [], 'a row the operator closed stays closed');
  assert.deepEqual(ask(settled('declined', 'not now')), [], 'and so does one they declined');
});

test('a sheet is drawn once its checks are written, before anyone has accepted them', () => {
  const arrival = {
    goalRef: 'issue:12',
    environment: 'acceptance',
    arrivedAt: new Date(NOW - 86_400_000).toISOString(),
    announcedAt: null,
    watchedAt: null,
    sheetedAt: null,
  };
  const step = (checkSet: { accepted: boolean; acceptedAt: string | null; authoredAt: string | null }) =>
    arrivalSheetStep({ arrival, validates: true, checkSet: () => checkSet, probeIntervalMs: 60_000, now: NOW });

  assert.equal(step({ accepted: false, acceptedAt: null, authoredAt: null }), 'awaiting-checks');
  assert.equal(step({ accepted: false, acceptedAt: null, authoredAt: new Date(NOW).toISOString() }), 'ready');
});

test('the boot after the watch left the sheet deletes the watch rows and their readings, and nothing else', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-watchrows-')), 'db.sqlite');
  const first = new Store(path);
  first.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
  first.close();
  const raw = new Database(path);
  const insert = raw.prepare(
    `INSERT INTO remote_sheet_rows (goal_ref, environment, row_id, kind, seq, title, source_id, selected, updated_at)
     VALUES ('issue:12', 'acceptance', ?, ?, 1, 't', 's', 1, '2026-09-08T12:00:00.000Z')`,
  );
  insert.run('watch:checkout-throws', 'signal');
  insert.run(`state:${QUERY.id}`, 'state');
  raw.close();

  const upgraded = new Store(path);
  assert.deepEqual(
    upgraded.remoteValidation.listRemoteSheetRows().map((r) => r.rowId),
    [`state:${QUERY.id}`],
  );
  upgraded.close();
});
