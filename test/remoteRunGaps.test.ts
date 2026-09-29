import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noSheetReason } from '../src/validation/remote/sheet.js';
import { arrivalSheetStep } from '../src/environments/watchWindow.js';
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

const reason = (over: Partial<Parameters<typeof noSheetReason>[0]>) =>
  noSheetReason({ environment: 'staging', status: 'reached', step: 'ready', ...over });

test('each arm of a missing sheet names the step still to come', () => {
  assert.match(reason({ status: 'absent' }).why, /not reached staging yet/);
  assert.match(reason({ status: 'partial' }).why, /Only part/);
  assert.match(reason({ status: 'unknown' }).why, /Could not tell/);
  assert.match(reason({ step: null }).why, /arrival is recorded on the next pulse/);
  assert.match(reason({ step: 'awaiting-checks' }).why, /checks are not accepted yet/);
  assert.match(reason({ step: 'ready' }).why, /set up on the next pulse/);
});

test('a run the pulse will never set up is offered to be set up by hand', () => {
  for (const step of ['sheeted', 'stale'] as const)
    assert.deepEqual(reason({ step }), {
      why: 'No run was set up automatically: the work reached staging before remote runs there could take it.',
      setUp: true,
    });
  for (const step of [null, 'awaiting-checks', 'ready'] as const) assert.equal(reason({ step }).setUp, false);
});

test('an arrival waiting on its checks is never stale, and is fresh again the moment they are accepted', () => {
  const later = Date.parse(NOW) + 60 * 60_000;
  const step = (over: Partial<Parameters<typeof arrivalSheetStep>[0]>) =>
    arrivalSheetStep({
      arrival: arrival(),
      validates: true,
      checkSet: () => ({ accepted: true, acceptedAt: null }),
      probeIntervalMs: 60_000,
      now: Date.parse(NOW),
      ...over,
    });
  assert.equal(step({}), 'ready');
  assert.equal(step({ arrival: arrival({ sheetedAt: NOW }) }), 'sheeted');
  assert.equal(
    step({ arrival: arrival({ sheetedAt: NOW }), checkSet: () => ({ accepted: false, acceptedAt: null }) }),
    'awaiting-checks',
    'a stamped arrival is offered by hand only once its checks are accepted',
  );
  assert.equal(step({ validates: false }), 'not-validating');
  assert.equal(
    step({ now: later, checkSet: () => ({ accepted: false, acceptedAt: null }) }),
    'awaiting-checks',
    'an hour of waiting on the checks does not make the arrival stale',
  );
  assert.equal(
    step({ now: later, checkSet: () => ({ accepted: true, acceptedAt: new Date(later - 1_000).toISOString() }) }),
    'ready',
    'accepted just now, so the sheet is assembled',
  );
  assert.equal(
    step({ now: later, checkSet: () => ({ accepted: true, acceptedAt: NOW }) }),
    'stale',
    'work and checks both settled long ago is the backfill the guard exists for',
  );
});

test('a deployment with no validate block says so rather than drawing nothing', () => {
  const gaps = remoteRunGaps([env({ validates: false })], [], []);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.environment, null);
  assert.match(gaps[0]?.why ?? '', /No environment declares a `validate` block/);
});

test('an environment that can run remotely but holds no sheet says why, in the server’s words', () => {
  const noSheet = { why: 'No run was set up automatically.', setUp: true };
  assert.deepEqual(remoteRunGaps([env()], [], [reach({ noSheet })]), [{ environment: 'staging', ...noSheet }]);
});

test('a goal with no landing at all still gets a line for every environment that could run it', () => {
  const gaps = remoteRunGaps([env(), env({ name: 'prod' }), env({ name: 'preview', validates: false })], [], []);
  assert.deepEqual(
    gaps.map((g) => g.environment),
    ['staging', 'prod'],
  );
  assert.match(gaps[0]?.why ?? '', /has not reached staging yet/);
});

test('the environment the pane is showing narrows the gaps, and one that cannot validate says so', () => {
  const both = [env(), env({ name: 'prod' }), env({ name: 'preview', validates: false })];
  assert.deepEqual(
    remoteRunGaps(both, [], [], 'prod').map((g) => g.environment),
    ['prod'],
  );
  assert.match(remoteRunGaps(both, [], [], 'preview')[0]?.why ?? '', /preview declares no `validate` block/);
});

test('an environment with a sheet has no gap', () => {
  const sheet = { environment: 'staging' } as RemoteSheetView;
  assert.deepEqual(remoteRunGaps([env()], [sheet], [reach()]), []);
});
