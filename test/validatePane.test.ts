import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStandings, pressBreakdown, pressableRows } from '../web/src/view/validatePane.js';
import type { RemoteSheetRowView, RemoteSheetView, ValidationCheckView } from '../src/wire.js';

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

test('the press says what its number is made of, because it is bigger than the ticks below it', () => {
  /* The sheet carries queries and measures that have no check to tick, and a press re-reads the
     checks already answered — so "Run 5 rows" over three ticked boxes needs its arithmetic said.
     The strip sits above the list, so the ticks it counts are the ones below it. */
  const s = sheet({
    rows: [
      row({ rowId: 'r1', sourceId: 'c1' }),
      row({ rowId: 'r2', sourceId: 'c2' }),
      row({ rowId: 'q1', kind: 'state', sourceId: 'q1' }),
      row({ rowId: 'm1', kind: 'measure', sourceId: 'm1' }),
    ],
  });
  assert.equal(pressableRows(s), 4);
  assert.deepEqual(pressBreakdown(s), { checks: 2, own: 2 });
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
