import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noSheetReason } from '../src/validation/remote/sheet.js';
import { remoteRunGaps } from '../web/src/view/validatePane.js';
import type { CockpitEnvironment, GoalArrival, GoalEnvironmentReachView, RemoteSheetView } from '../src/wire.js';

// → docs/spec/36-remote-validation.md#when-there-is-no-sheet, docs/spec/17-cockpit.md#the-validate-pane

const NOW = '2025-01-01T00:00:00.000Z';

function arrival(over: Partial<GoalArrival> = {}): GoalArrival {
  return {
    goalRef: 'issue:12',
    environment: 'staging',
    arrivedAt: NOW,
    announcedAt: null,
    watchedAt: null,
    sheetedAt: null,
    ...over,
  };
}

function env(over: Partial<CockpitEnvironment> = {}): CockpitEnvironment {
  return { name: 'staging', opens: [], watched: false, validates: true, ...over };
}

function reach(over: Partial<GoalEnvironmentReachView> = {}): GoalEnvironmentReachView {
  return {
    environment: 'staging',
    status: 'absent',
    landed: 0,
    total: 1,
    unplaced: 0,
    at: null,
    opens: [],
    sheet: null,
    noSheet: null,
    ...over,
  };
}

const reason = (over: Partial<Parameters<typeof noSheetReason>[0]>): string =>
  noSheetReason({ environment: 'staging', status: 'reached', arrival: arrival(), checkSetAccepted: true, ...over });

test('each arm of a missing sheet names the step still to come', () => {
  assert.match(reason({ status: 'absent' }), /not reached staging yet/);
  assert.match(reason({ status: 'partial' }), /Only part/);
  assert.match(reason({ status: 'unknown' }), /Could not tell/);
  assert.match(reason({ arrival: undefined }), /arrival is recorded on the next pulse/);
  assert.match(reason({ arrival: arrival({ sheetedAt: NOW }) }), /before remote runs could take it/);
  assert.match(reason({ checkSetAccepted: false }), /checks are not accepted yet/);
  assert.match(reason({}), /set up on the next pulse/);
});

test('a deployment with no validate block says so rather than drawing nothing', () => {
  const gaps = remoteRunGaps([env({ validates: false })], [], []);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.environment, null);
  assert.match(gaps[0]?.why ?? '', /No environment declares a `validate` block/);
});

test('an environment that can run remotely but holds no sheet says why, in the server’s words', () => {
  const why = 'This goal’s work has not reached staging yet — a run is offered once it does.';
  assert.deepEqual(remoteRunGaps([env()], [], [reach({ noSheet: why })]), [{ environment: 'staging', why }]);
});

test('a goal with no landing at all still gets a line for every environment that could run it', () => {
  const gaps = remoteRunGaps([env(), env({ name: 'prod' }), env({ name: 'preview', validates: false })], [], []);
  assert.deepEqual(
    gaps.map((g) => g.environment),
    ['staging', 'prod'],
  );
  assert.match(gaps[0]?.why ?? '', /None of this goal's work has landed yet/);
});

test('an environment with a sheet has no gap', () => {
  const sheet = { environment: 'staging' } as RemoteSheetView;
  assert.deepEqual(remoteRunGaps([env()], [sheet], [reach()]), []);
});
