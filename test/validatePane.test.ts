import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStandings, panelRows, okStanding, pressableRows, tenantAlerts } from '../web/src/view/validatePane.js';
import type {
  RemoteRunIntent,
  RemoteRunView,
  RemoteSheetRowView,
  RemoteSheetView,
  ValidationCheckView,
} from '../src/wire.js';

// → docs/spec/17-cockpit.md#the-validate-pane

const NOW = '2025-01-01T00:00:00.000Z';

function check(over: Partial<ValidationCheckView> = {}): ValidationCheckView {
  return {
    originRef: 'issue:12',
    id: 'c1',
    letter: 'A',
    seq: 1,
    title: 'A refund writes a ledger entry',
    do: 'Refund an order and open the ledger.',
    expect: 'One entry.',
    proof: null,
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    claimedBy: null,
    claimedAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    steps: [],
    capture: null,
    captureUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function row(over: Partial<RemoteSheetRowView> = {}): RemoteSheetRowView {
  return {
    goalRef: 'issue:12',
    environment: 'staging',
    rowId: 'check:c1',
    kind: 'check',
    seq: 1,
    title: 'A refund writes a ledger entry',
    sourceId: 'c1',
    selected: true,
    blockedReason: null,
    awaitingApproval: false,
    matched: 2,
    idleReason: null,
    reading: null,
    ...over,
  };
}

function sheet(over: Partial<RemoteSheetView> = {}): RemoteSheetView {
  return {
    goalRef: 'issue:12',
    environment: 'staging',
    assembledAt: NOW,
    rows: [row()],
    run: null,
    intent: null,
    okable: 1,
    tenant: {
      tenant: 'validation-1',
      reseededAt: null,
      ageMs: null,
      freshnessMs: null,
      stale: false,
      blockedReason: null,
      reseedable: false,
      destructive: false,
      preparation: null,
    },
    ...over,
  };
}

function run(status: 'pending' | 'dispatched' | 'ended'): RemoteSheetView['run'] {
  return {
    id: 'run-1',
    goalRef: 'issue:12',
    environment: 'staging',
    tenant: 'validation-1',
    status,
    startedSha: null,
    endedSha: null,
    startedAt: NOW,
    endedAt: null,
    note: null,
    taskId: null,
    reportPath: null,
    listingPath: null,
    artefacts: null,
  };
}

test('a check a live run carries reads as running, and names the environment it is on', () => {
  const standings = checkStandings([check()], [sheet({ run: run('dispatched') })]);
  assert.equal(standings.get('c1')?.band, 'running');
  assert.equal(standings.get('c1')?.label, 'a run on staging');
});

test('a check a press would read, with no run on it, is open and names what could take it', () => {
  const standings = checkStandings([check()], [sheet({ run: run('ended') })]);
  assert.equal(standings.get('c1')?.band, 'open');
  assert.equal(standings.get('c1')?.label, 'staging can take it');
});

test('a row no press can read leaves its check with the operator, and so does no sheet at all', () => {
  /* Both halves of the residue: the server's own folds are what say a press reads nothing here, and a
     goal with no sheet has nobody offering. Neither is the cockpit judging whether the fleet could
     carry the check. → docs/spec/36-remote-validation.md#a-row-no-press-can-read */
  const idle = checkStandings([check()], [sheet({ rows: [row({ idleReason: 'a person carries every step' })] })]);
  assert.equal(idle.get('c1')?.band, 'yours');

  const blocked = checkStandings([check()], [sheet({ rows: [row({ blockedReason: 'the area is gone' })] })]);
  assert.equal(blocked.get('c1')?.band, 'yours');

  assert.equal(checkStandings([check()], []).get('c1')?.band, 'yours');
});

test('a settled check is answered, and says which run carried the reading', () => {
  const through = checkStandings(
    [check({ state: 'passed', resultBy: 'spec' })],
    [sheet({ rows: [row({ reading: reading() })] })],
  );
  assert.equal(through.get('c1')?.band, 'answered');
  assert.equal(through.get('c1')?.label, 'a run on staging');

  /* No sheet behind it: the row says only who recorded the reading, which is the record's own word
     and never a guess at a run that did not happen. */
  const byHand = checkStandings([check({ state: 'passed', resultBy: 'operator' })], []);
  assert.equal(byHand.get('c1')?.label, 'you');
  assert.equal(checkStandings([check({ state: 'waived', resultBy: null })], []).get('c1')?.label, 'answered');
});

test('a superseded check gets no standing at all', () => {
  const standings = checkStandings([check({ supersededReason: 'the plan moved past it' })], [sheet()]);
  assert.equal(standings.size, 0);
});

test('the pressable count is the gate’s own, and it counts rows rather than checks', () => {
  const s = sheet({
    rows: [
      row({ rowId: 'r1', sourceId: 'c1' }),
      row({ rowId: 'r2', sourceId: 'c2', selected: false }),
      row({ rowId: 'r3', sourceId: 'c3', blockedReason: 'the area is gone' }),
      row({ rowId: 'r4', sourceId: 'c4', idleReason: 'a person carries every step' }),
    ],
  });
  assert.equal(pressableRows(s), 1);
});

test('a page reads where it stands off its intent, its run and its rows to OK', () => {
  const RUN = { id: 'run_1', status: 'ended', note: null } as unknown as RemoteRunView;
  const intent = (over: Partial<RemoteRunIntent>): RemoteRunIntent => ({
    goalRef: 'issue:12',
    environment: 'staging',
    state: 'given',
    fingerprint: 'f',
    givenAt: NOW,
    runId: null,
    note: null,
    updatedAt: NOW,
    ...over,
  });
  assert.equal(okStanding(sheet()).status, 'needs-you', 'a row to OK and no OK');
  assert.equal(okStanding(sheet({ okable: 0 })).status, 'nothing', 'nothing to OK asks for nothing');
  assert.deepEqual(okStanding(sheet({ intent: intent({ note: 'queued behind the run for issue:398.' }) })), {
    status: 'queued',
    why: 'queued behind the run for issue:398.',
  });
  assert.equal(okStanding(sheet({ run: { ...RUN, status: 'dispatched' } })).status, 'running');
  assert.equal(okStanding(sheet({ run: RUN, intent: intent({ state: 'consumed', runId: 'run_1' }) })).status, 'done');
  assert.deepEqual(
    okStanding(
      sheet({
        run: { ...RUN, status: 'abandoned', note: 'gone back past this goal' },
        intent: intent({ state: 'consumed', runId: 'run_1' }),
      }),
    ),
    { status: 'needs-you', why: 'gone back past this goal' },
    'an abandoned run comes back to the operator, saying why',
  );
  assert.equal(okStanding(sheet({ intent: intent({ state: 'consumed', runId: null }) })).status, 'open', 'ship day');
  assert.equal(okStanding(sheet({ intent: intent({ state: 'not_here', note: 'rebuilt' }) })).why, 'rebuilt');
  assert.equal(
    okStanding(sheet({ intent: intent({ state: 'withdrawn', note: 'the page has changed' }) })).why,
    'the page has changed',
  );
});

test('a check carries the box of the environment the pane is showing, and none where it holds no row', () => {
  /* One answer about what a press will carry: the box writes the sheet's own `selected` through the
     sheet's own route. Where the shown environment has no readable row for the check there is no
     box at all — a box that wrote nothing would be the second opinion this pane is built against. */
  const staging = sheet({ rows: [row({ sourceId: 'c1', selected: false })] });
  const prod = sheet({ environment: 'prod', rows: [row({ environment: 'prod', sourceId: 'c1' })] });
  const shown = checkStandings([check()], [staging, prod], 'staging');
  assert.deepEqual(shown.get('c1')?.row, {
    environment: 'staging',
    rowId: 'check:c1',
    selected: false,
    live: false,
    awaitingApproval: false,
  });
  assert.equal(checkStandings([check()], [prod], 'staging').get('c1')?.row, null, 'no row there, no box');
  assert.equal(
    checkStandings([check()], [staging, prod]).get('c1')?.row,
    null,
    'and none where two environments hold one and the pane is showing neither',
  );
});

test('a check carries what each environment’s run made of it, and nothing where no run touched it', () => {
  /* The pane read a check at the top and its run at the foot, so a check marked "not run" above sat
     over a "blocked" row of the same check below. The check now carries its own runs. */
  const blocked = row({ blockedReason: 'hallway moved under this run' });
  const hallway = sheet({ environment: 'hallway', rows: [{ ...blocked, environment: 'hallway' }] });
  const passed = sheet({ rows: [row({ reading: reading() })] });
  const runs = checkStandings([check()], [hallway, passed]).get('c1')?.runs ?? [];
  assert.deepEqual(
    runs.map((r) => r.environment),
    ['hallway', 'staging'],
  );

  assert.deepEqual(checkStandings([check()], [sheet()]).get('c1')?.runs, [], 'an unread row is no run');
  const query = sheet({ rows: [row({ kind: 'state', sourceId: 'c1', reading: reading() })] });
  assert.deepEqual(checkStandings([check()], [query]).get('c1')?.runs, [], 'and only a check row is the check’s');
});

test('the environment panel lists only the rows that are not a check’s own, bar one awaiting approval', () => {
  const s = sheet({
    rows: [
      row({ rowId: 'r1' }),
      row({ rowId: 'r2', awaitingApproval: true }),
      row({ rowId: 'q1', kind: 'signal', sourceId: 'q1' }),
    ],
  });
  assert.deepEqual(
    panelRows(s).map((r) => r.rowId),
    ['r2', 'q1'],
  );
});

test('an unhealthy tenant is an alert: blocked, then a failed preparation, then stale', () => {
  const tenant = sheet().tenant;
  const prep = (over: Partial<NonNullable<typeof tenant.preparation>>): NonNullable<typeof tenant.preparation> => ({
    environment: 'staging',
    tenant: 'validation-1',
    startedAt: NOW,
    finishedAt: NOW,
    ok: true,
    detail: null,
    call: null,
    launchedAt: null,
    ...over,
  });
  const alerted = (over: Partial<typeof tenant>) => tenantAlerts([sheet({ tenant: { ...tenant, ...over } })]);

  assert.deepEqual(alerted({}), [], 'a healthy tenant says nothing');
  assert.equal(alerted({ blockedReason: 'no tenant variable', stale: true })[0]?.why, 'blocked');
  assert.deepEqual(alerted({ stale: true, preparation: prep({ ok: false, detail: 'exited 1' }) }), [
    { environment: 'staging', tenant: 'validation-1', why: 'failed', detail: 'exited 1' },
  ]);
  assert.equal(alerted({ stale: true })[0]?.why, 'stale');
  /* A preparation still running is the gate's to follow, and an unknown outcome is not a failure. */
  assert.deepEqual(alerted({ stale: true, preparation: prep({ finishedAt: null, ok: null }) }), []);
  assert.equal(alerted({ preparation: prep({ ok: null }) }).length, 0);

  const prod = sheet({ environment: 'prod', tenant: { ...tenant, stale: true } });
  assert.equal(tenantAlerts([prod], 'staging').length, 0, 'narrowed to the environment the pane shows');
});

function reading(): NonNullable<RemoteSheetRowView['reading']> {
  return {
    goalRef: 'issue:12',
    environment: 'staging',
    rowId: 'check:c1',
    runId: 'run-1',
    outcome: 'passed',
    rows: null,
    value: null,
    detail: null,
    startedSha: null,
    endedSha: null,
    executed: 2,
    retries: 0,
    durationMs: 100,
    readAt: NOW,
    capture: null,
    captureUrl: null,
    taskId: null,
    agentId: null,
    artefacts: null,
  };
}
