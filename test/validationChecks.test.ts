import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBands,
  checkBoxTitle,
  checkStandings,
  oddState,
  runOutcome,
  type CheckStanding,
} from '../web/src/view/validatePane.js';
import {
  checkQueue,
  digestCount,
  isMissingFile,
  isOwed,
  lineAside,
  resourcesFor,
  resourceTitle,
  splitChecks,
} from '../web/src/view/validationChecks.js';
import type {
  RemoteReadingView,
  RemoteSheetRowView,
  RemoteSheetView,
  ValidationCheckView,
  ValidationResourceView,
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
    okable: { checks: 1, queries: 0, approvals: 0 },
    ok: { status: 'needs-you', why: null },
    tenant: {
      tenant: 'validation-1',
      reseededAt: null,
      ageMs: null,
      freshnessMs: null,
      stale: false,
      halfSeeded: false,
      blockedReason: null,
      reseedable: false,
      destructive: false,
      preparation: null,
    },
    ...over,
  };
}

function resource(over: Partial<ValidationResourceView> = {}): ValidationResourceView {
  return {
    originRef: 'issue:12',
    name: 'fixture',
    kind: null,
    note: null,
    provided: false,
    humanTaskId: null,
    path: 'validation/fixture.json',
    present: true,
    ...over,
  };
}

function standing(band: CheckStanding['band'], label: string): CheckStanding {
  return { band, label, row: null, runs: [] };
}

test('the split keeps live checks apart from those an amendment dropped', () => {
  const { live, withdrawn } = splitChecks([check({ id: 'a' }), check({ id: 'b', supersededReason: 'merged into A' })]);
  assert.deepEqual(
    live.map((c) => c.id),
    ['a'],
  );
  assert.deepEqual(
    withdrawn.map((c) => c.id),
    ['b'],
  );
});

test('only passed and waived settle a check', () => {
  assert.equal(isOwed(check({ state: 'passed' })), false);
  assert.equal(isOwed(check({ state: 'waived' })), false);
  for (const state of ['unrun', 'captured', 'failed', 'deferred', 'declined'] as const)
    assert.equal(isOwed(check({ state })), true, state);
});

test('the queue opens the first check owed, and lists the rest owed apart from done', () => {
  const live = [
    check({ id: 'a', state: 'passed' }),
    check({ id: 'b' }),
    check({ id: 'c' }),
    check({ id: 'd', state: 'waived', amendedAt: NOW }),
  ];
  const q = checkQueue(live, null, false);
  assert.deepEqual(
    q.shown.map((c) => c.id),
    ['b'],
  );
  assert.deepEqual(
    q.owed.map((c) => c.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    q.rest.owed.map((c) => c.id),
    ['c'],
  );
  assert.deepEqual(
    q.rest.done.map((c) => c.id),
    ['a', 'd'],
  );
});

test('a pin wins over the queue, and a pin the set no longer holds falls back to it', () => {
  const live = [check({ id: 'a', state: 'passed' }), check({ id: 'b' })];
  assert.deepEqual(
    checkQueue(live, 'a', false).shown.map((c) => c.id),
    ['a'],
  );
  assert.deepEqual(
    checkQueue(live, 'gone', false).shown.map((c) => c.id),
    ['b'],
  );
});

test('with nothing owed the queue opens the first check, and drawn whole it has no rest', () => {
  const live = [check({ id: 'a', state: 'passed' }), check({ id: 'b', state: 'waived' })];
  assert.deepEqual(
    checkQueue(live, null, false).shown.map((c) => c.id),
    ['a'],
  );
  const all = checkQueue(live, null, true);
  assert.deepEqual(
    all.shown.map((c) => c.id),
    ['a', 'b'],
  );
  assert.deepEqual(all.rest, { owed: [], done: [] });
  assert.deepEqual(checkQueue([], null, false).shown, []);
});

test('the digest counts settled checks, and says withdrawn when none are live', () => {
  assert.equal(
    digestCount([check({ state: 'passed' }), check({ state: 'failed' }), check({ state: 'waived' })]),
    '2 of 3 done',
  );
  assert.equal(digestCount([]), 'withdrawn');
});

test('a line says the loudest of changed, back with you and with the fleet', () => {
  assert.equal(lineAside(check({ amendedAt: NOW, handbackNote: 'no login', actor: 'fleet' })), 'changed');
  assert.equal(lineAside(check({ handbackNote: 'no login', actor: 'fleet' })), 'back with you');
  assert.equal(lineAside(check({ actor: 'fleet' })), 'with the fleet');
  assert.equal(lineAside(check()), null);
});

test('a file that is not present is missing, an access resource never is', () => {
  assert.equal(isMissingFile(resource({ present: false })), true);
  assert.equal(isMissingFile(resource({ present: false, kind: 'access' })), false);
  assert.equal(isMissingFile(resource()), false);
});

test('a check gets the resources it names, in its order, skipping names the set lacks', () => {
  const usedBy = resourcesFor([resource({ name: 'x' }), resource({ name: 'y' })]);
  assert.deepEqual(
    usedBy(check({ uses: ['y', 'nope', 'x'] })).map((r) => r.name),
    ['y', 'x'],
  );
});

test('a resource hover carries its note under a blank line', () => {
  assert.equal(resourceTitle(resource()), 'validation/fixture.json');
  assert.equal(resourceTitle(resource({ note: 'seeded' })), 'validation/fixture.json\n\nseeded');
});

test('bands come in reading order, empty ones left out, with a runner only where the band agrees', () => {
  const live = [check({ id: 'a' }), check({ id: 'b' }), check({ id: 'c' }), check({ id: 'd' }), check({ id: 'e' })];
  const standings = new Map<string, CheckStanding>([
    ['a', standing('answered', 'you')],
    ['b', standing('open', 'staging can take it')],
    ['c', standing('open', 'prod can take it')],
    ['d', standing('running', 'a run on staging')],
    ['e', standing('yours', 'no run offers to take this')],
  ]);
  const bands = checkBands(live, standings);
  assert.deepEqual(
    bands.map((b) => [b.band, b.checks.map((c) => c.id), b.runner]),
    [
      ['running', ['d'], 'a run on staging'],
      ['open', ['b', 'c'], null],
      ['yours', ['e'], null],
      ['answered', ['a'], 'you'],
    ],
  );
});

test('bands drawn from real standings carry the checks a sheet offers', () => {
  const live = [check()];
  const bands = checkBands(live, checkStandings(live, [sheet()]));
  assert.deepEqual(
    bands.map((b) => [b.band, b.runner]),
    [['open', 'staging can take it']],
  );
});

test('a state is said only where its band does not already imply it', () => {
  assert.equal(oddState('open', 'unrun'), null);
  assert.equal(oddState('open', 'failed'), 'failed');
  assert.equal(oddState('answered', 'passed'), null);
  assert.equal(oddState('answered', 'waived'), 'waived');
  assert.equal(oddState('running', 'unrun'), 'unrun');
});

test('a box says what the next run will do with its row', () => {
  const base = { environment: 'staging', rowId: 'check:c1', selected: true, live: false, awaitingApproval: false };
  assert.equal(checkBoxTitle({ ...base, live: true, awaitingApproval: true }), 'A run on staging is carrying it now');
  assert.match(checkBoxTitle({ ...base, awaitingApproval: true }), /needs approving/);
  assert.match(checkBoxTitle(base), /Untick to leave it out/);
  assert.equal(checkBoxTitle({ ...base, selected: false }), 'Left out of staging’s next run. Tick to put it back');
});

test('a block outranks a reading, and a row with neither has no outcome', () => {
  const reading = { outcome: 'failed' } as RemoteReadingView;
  assert.equal(runOutcome(row({ blockedReason: 'no tenant', reading })), 'blocked');
  assert.equal(runOutcome(row({ reading })), 'failed');
  assert.equal(runOutcome(row()), null);
});
