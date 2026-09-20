import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { environmentGroups } from '../src/environments/groups.js';
import { announceableArrivals, environmentGateHold, openedGoals } from '../src/environments/arrival.js';
import { allGoalReach } from '../src/environments/reach.js';
import { buildFeatureBoard } from '../src/features/featureBoard.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import type { EnvironmentReading, GoalArrival, GoalLanding } from '../src/types.js';

// → docs/spec/24-environments.md#groups

const PROD: EnvironmentConfig[] = [
  { name: 'liveEu', at: 'eu', group: 'prod', arrival: { opens: ['close_out'], comment: true } },
  { name: 'liveUs', at: 'us', group: 'prod', arrival: { opens: ['close_out'], comment: true } },
];

function arrival(over: Partial<GoalArrival> & { environment: string }): GoalArrival {
  return {
    goalRef: 'issue:12',
    arrivedAt: '2026-01-02T00:00:00.000Z',
    announcedAt: null,
    watchedAt: null,
    sheetedAt: null,
    ...over,
  };
}

function landing(over: Partial<GoalLanding> & { prNumber: number; sha: string }): GoalLanding {
  return { goalRef: 'issue:12', recordedAt: '2026-01-01T00:00:00.000Z', onIntegration: true, ...over };
}

function reading(over: Partial<EnvironmentReading> & { sha: string; environment: string }): EnvironmentReading {
  return { status: 'reached', detail: null, observedAt: '2026-01-02T00:00:00.000Z', ...over };
}

test('an ungrouped environment is a band of one, and a declared group is a band of its members', () => {
  assert.deepEqual(environmentGroups([{ name: 'staging', at: 's' }, ...PROD]), [
    { name: 'staging', environments: ['staging'], declared: false },
    { name: 'prod', environments: ['liveEu', 'liveUs'], declared: true },
  ]);
});

test('a group named after an environment is refused — one row cannot stand for two places', () => {
  assert.throws(() => validateEnvironments([{ name: 'prod', at: 'p' }, ...PROD]), /also an environment's own name/);
});

test('a group whose members disagree about arrival is refused', () => {
  assert.throws(
    () =>
      validateEnvironments([
        PROD[0]!,
        { name: 'liveUs', at: 'us', group: 'prod', arrival: { opens: ['validate'], comment: true } },
      ]),
    /different\n?\s*"arrival" block|different "arrival" block/,
  );
  assert.throws(() => validateEnvironments([{ name: 'liveEu', at: 'eu', group: '  ' }]), /"group" must be a non-empty/);
  validateEnvironments([...PROD]);
});

test('a group opens its gate only once every one of its environments holds the work', () => {
  const half = openedGoals('close_out', PROD, [arrival({ environment: 'liveEu' })], []);
  assert.deepEqual([...(half ?? [])], [], 'one region is not production');

  const whole = openedGoals(
    'close_out',
    PROD,
    [arrival({ environment: 'liveEu' }), arrival({ environment: 'liveUs' })],
    [],
  );
  assert.deepEqual([...(whole ?? [])], ['issue:12']);
});

test('two bands still open a gate independently — the AND is inside a group, never across them', () => {
  const environments: EnvironmentConfig[] = [{ name: 'staging', at: 's', arrival: { opens: ['close_out'] } }, ...PROD];
  const open = openedGoals('close_out', environments, [arrival({ environment: 'staging' })], []);
  assert.deepEqual([...(open ?? [])], ['issue:12']);
});

test('the hold names the group and the environments it is made of', () => {
  const said = environmentGateHold({
    goalRef: 'issue:12',
    environments: PROD,
    arrivals: [arrival({ environment: 'liveEu' })],
    releases: [],
  });
  assert.equal(said, 'the close-out is waiting for this work to reach prod (liveEu, liveUs).');
});

test('a group is said on the ticket once, when the last of its environments takes the work', () => {
  const now = Date.parse('2026-01-02T00:05:00.000Z');
  const readings = [
    reading({ sha: 'a', environment: 'liveEu', observedAt: '2026-01-01T00:00:00.000Z' }),
    reading({ sha: 'a', environment: 'liveUs', observedAt: '2026-01-01T00:00:00.000Z' }),
  ];
  const landings = [landing({ prNumber: 1, sha: 'a' })];

  const half = announceableArrivals({
    arrivals: [arrival({ environment: 'liveEu' })],
    environments: PROD,
    readings,
    landings,
    probeIntervalMs: 300_000,
    now,
  });
  assert.deepEqual(
    half.map((a) => ({ env: a.arrival.environment, comment: a.comment })),
    [{ env: 'liveEu', comment: false }],
    'the first region to take it is marked announced saying nothing',
  );

  const whole = announceableArrivals({
    arrivals: [
      arrival({ environment: 'liveEu' }),
      arrival({ environment: 'liveUs', arrivedAt: '2026-01-02T00:01:00.000Z' }),
    ],
    environments: PROD,
    readings,
    landings,
    probeIntervalMs: 300_000,
    now,
  });
  assert.deepEqual(
    whole.map((a) => ({ env: a.arrival.environment, comment: a.comment, said: a.said })),
    [
      { env: 'liveEu', comment: false, said: 'prod' },
      { env: 'liveUs', comment: true, said: 'prod' },
    ],
    'said once, by the region that completed the place, and naming the place',
  );
});

test('a group’s reach is the laggard’s — one region holding it is partial, not reached', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' }), landing({ prNumber: 2, sha: 'b' })];
  const rolled = (readings: EnvironmentReading[]) =>
    allGoalReach({
      landings,
      readings,
      nodes: [],
      landed: new Set([1, 2]),
      plans: [],
      parts: [],
      environments: PROD,
    })[0]?.groups[0];

  assert.deepEqual(
    rolled([
      reading({ sha: 'a', environment: 'liveEu' }),
      reading({ sha: 'b', environment: 'liveEu' }),
      reading({ sha: 'a', environment: 'liveUs' }),
      reading({ sha: 'b', environment: 'liveUs', status: 'absent' }),
    ]),
    {
      group: 'prod',
      environments: ['liveEu', 'liveUs'],
      status: 'partial',
      landed: 1,
      total: 2,
      at: null,
      opens: ['close_out'],
    },
  );

  const all = rolled([
    reading({ sha: 'a', environment: 'liveEu' }),
    reading({ sha: 'b', environment: 'liveEu' }),
    reading({ sha: 'a', environment: 'liveUs' }),
    reading({ sha: 'b', environment: 'liveUs', observedAt: '2026-01-03T00:00:00.000Z' }),
  ]);
  assert.equal(all?.status, 'reached');
  assert.equal(all?.at, '2026-01-03T00:00:00.000Z', 'when the last of them took it');
});

test('an ungrouped deployment gets no group rows at all', () => {
  const rows = allGoalReach({
    landings: [landing({ prNumber: 1, sha: 'a' })],
    readings: [reading({ sha: 'a', environment: 'staging' })],
    nodes: [],
    landed: new Set([1]),
    plans: [],
    parts: [],
    environments: [{ name: 'staging', at: 's' }],
  });
  assert.deepEqual(rows[0]?.groups, []);
});

function ticket(number: number, parent: number): MirroredTicket {
  return {
    number,
    title: `goal ${number}`,
    state: 'open',
    issueType: 'User Story',
    workItemState: 'Active',
    labels: ['lubbdubb'],
    parent: { number: parent, title: 'a Feature' },
    url: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    changedAt: '2026-01-01T00:00:00.000Z',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    tracking: 'live',
    lastReadAt: null,
  };
}

test('the Feature board draws a column per band, and the band holds a goal only when all of it does', () => {
  const band = { name: 'prod', environments: ['liveEu', 'liveUs'], declared: true };
  const board = (status: 'reached' | 'absent') =>
    buildFeatureBoard({
      items: [ticket(1, 9)],
      outcomes: new Map(),
      costs: new Map(),
      featureSlots: new Map(),
      running: new Map(),
      summaries: new Map(),
      sequences: new Map(),
      standingKeys: new Map(),
      deliveries: [],
      shortfalls: [],
      escalations: [],
      reach: [
        {
          goalRef: 'issue:1',
          environments: [
            { environment: 'liveEu', status: 'reached', landed: 1, total: 1, unplaced: 0, at: null, opens: [] },
            { environment: 'liveUs', status, landed: 1, total: 1, unplaced: 0, at: null, opens: [] },
          ],
        },
      ],
      landings: [],
      environments: [band],
      containerTypes: ['Feature'],
      watchLabel: 'lubbdubb',
    });

  assert.deepEqual(board('absent').features[0]?.reach, [
    { environment: 'prod', status: 'unknown', goals: 0, total: 1 },
  ]);
  assert.deepEqual(board('reached').features[0]?.reach, [
    { environment: 'prod', status: 'reached', goals: 1, total: 1 },
  ]);
});
