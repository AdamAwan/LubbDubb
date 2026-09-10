import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { validatePlanDocument, parsePlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { testPartNote } from '../src/plans/planning.js';
import { ValidationCheckSchema, validationCheckSetInputs } from '../src/validation/checkDocument.js';
import { stepCapabilities } from '../src/validation/steps.js';
import { runnableSelectors } from '../src/remoteValidation/briefing.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';

/*
 * How a check comes to have an area. The planner picks one from the runner's own offering, a part
 * carries it as `coverage`, and the validation planner writes a `suite` step naming one — which is
 * what lands in `validation_checks.area`, what the pre-flight compares, and what the run's selectors
 * are drawn from. **A `covers` entry no longer decides any of it**: it is a bibliography, and while
 * it was the join a check became automatable by accident.
 *
 * → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: {
    permits: ['check'],
    browser: {
      runner: 'npm run e2e',
      listSelectors: 'npm run e2e -- --list',
    },
  },
};

const OFFERING = JSON.stringify([
  { selector: 'Checkout Tests', tests: 4 },
  { selector: 'Login Tests', tests: 2 },
]);

function document(input: { coverage?: string; covers?: string[] }): string {
  return JSON.stringify({
    version: 1,
    reason: 'The change, and the coverage it invalidates.',
    parts: [
      { slug: 'checkout', title: 'The confirmation step', scope: 'src/checkout/' },
      {
        slug: 'checkout-coverage',
        title: 'Amend the checkout coverage',
        scope: 'e2e/',
        ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
      },
    ],
    validation: {
      checks: [
        {
          id: 'an-order-places',
          title: 'An order still places end to end',
          do: 'Place one',
          expect: 'It places',
          covers: input.covers ?? ['checkout-coverage'],
        },
      ],
    },
  });
}

// --------------------------------------------------------------- the offering

test('the planner is handed the runner’s own offering rather than asked to describe an area', () => {
  const enumerated = testPartNote(
    [ACCEPTANCE],
    [
      { environment: 'acceptance', selector: 'Checkout Tests' },
      { environment: 'acceptance', selector: 'Login Tests' },
    ],
  );
  assert.match(enumerated, /`Checkout Tests`, `Login Tests`/, 'it names what the runner offers');
  assert.match(enumerated, /copied exactly/, 'and says the string is compared character for character');
  assert.doesNotMatch(enumerated, /in words rather than as a file path/, 'so it is a pick, not a description');

  // Nothing listed yet is the arm that must not withhold: the prose form, and a plan still submits.
  const prose = testPartNote([ACCEPTANCE]);
  assert.match(prose, /in words rather than as a file path/);
  assert.match(prose, /`coverage`/);
});

test('an offering from an environment with no browser block is not offered to the planner', () => {
  const note = testPartNote(
    [ACCEPTANCE, { name: 'staging', at: 'echo sha' }],
    [
      { environment: 'acceptance', selector: 'Checkout Tests' },
      { environment: 'staging', selector: 'Something Else' },
    ],
  );
  assert.match(note, /`Checkout Tests`/);
  assert.doesNotMatch(note, /Something Else/, 'a runner nobody declared offers nothing here');
});

// -------------------------------------------------------------- the refusal

test('a coverage the deployed suite does not offer is refused where it is authored', () => {
  const bad = validatePlanDocument(JSON.parse(document({ coverage: 'the checkout area' })), [
    'Checkout Tests',
    'Login Tests',
  ]);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /"checkout-coverage" names `the checkout area`/);
  assert.match(bad.error, /`Checkout Tests`, `Login Tests`/, 'and it says what may be named instead');

  const good = validatePlanDocument(JSON.parse(document({ coverage: 'Checkout Tests' })), [
    'Checkout Tests',
    'Login Tests',
  ]);
  assert.equal(good.ok, true);
});

test('an empty offering fails open — a listing nobody has taken never withholds a plan', () => {
  const parsed = validatePlanDocument(JSON.parse(document({ coverage: 'anything at all' })), []);
  assert.equal(parsed.ok, true, 'no listing yet, a runner that could not answer and no browser block are one arm');
  const viaFile = parsePlanDocument(document({ coverage: 'anything at all' }));
  assert.equal(viaFile.ok, true, 'and the file transport is the same loader');
});

// ------------------------------------------------------------------ the join

/** One check, authored the way the validation planner authors it: through the shared schema. */
function authored(store: Store, steps: unknown[], covers: string[] = []): void {
  const parsed = ValidationCheckSchema.safeParse({
    id: 'an-order-places',
    title: 'An order still places end to end',
    do: 'Place one',
    expect: 'It places',
    covers,
    steps,
  });
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  if (!parsed.success) return;
  store.ingestValidation('issue:12', {
    checks: validationCheckSetInputs(
      [parsed.data],
      [],
      ['checkout', 'checkout-coverage'],
      stepCapabilities([ACCEPTANCE]),
    ),
    resources: [],
    supersededReason: 'gone',
    amendNote: 'changed',
  });
}

test('a suite step names the area, and it is what lands on the row', () => {
  const store = new Store(':memory:');
  try {
    const parsed = parsePlanDocument(document({ coverage: 'Checkout Tests' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Checkout' });
    authored(store, [{ kind: 'suite', do: 'Run the checkout area', area: 'Checkout Tests' }]);

    const check = store.listValidationChecks('issue:12')[0];
    assert.equal(check?.area, 'Checkout Tests', 'the column the pre-flight compares is written by the step');
    assert.equal(check?.steps[0]?.actor, 'fleet', 'and the environment declares a browser block, so the fleet has it');
  } finally {
    store.close();
  }
});

test('covering a test part is a bibliography and no longer an area', () => {
  const store = new Store(':memory:');
  try {
    const parsed = parsePlanDocument(document({ coverage: 'Checkout Tests' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Checkout' });
    authored(store, [{ kind: 'manual', do: 'Look at it' }], ['checkout-coverage']);

    const check = store.listValidationChecks('issue:12')[0];
    assert.deepEqual(check?.covers, ['checkout-coverage'], 'the entry is kept — it says what the check exercises');
    assert.equal(
      check?.area,
      null,
      'and it decides nothing: a check became automatable by accident while this was the join',
    );
  } finally {
    store.close();
  }
});

test('a plan document’s own legacy check set inherits nothing either', () => {
  const store = new Store(':memory:');
  try {
    const parsed = parsePlanDocument(document({ coverage: 'Checkout Tests' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Checkout' });
    assert.equal(store.listValidationChecks('issue:12')[0]?.area, null);
  } finally {
    store.close();
  }
});

test('an area on any step but a suite step is refused where it is authored', () => {
  const spread = ValidationCheckSchema.safeParse({
    id: 'x',
    title: 'T',
    do: 'd',
    expect: 'e',
    steps: [{ kind: 'browser', do: 'click', area: 'Checkout Tests' }],
  });
  assert.equal(spread.success, false);
  if (spread.success) return;
  assert.match(spread.error.issues[0]?.message ?? '', /belongs to a "suite" step/);

  const nameless = ValidationCheckSchema.safeParse({
    id: 'x',
    title: 'T',
    do: 'd',
    expect: 'e',
    steps: [{ kind: 'suite', do: 'run it' }],
  });
  assert.equal(nameless.success, false, 'and a suite step that names no area runs nothing');
});

test('the first suite step wins, so a check is still verified against one selector', () => {
  const store = new Store(':memory:');
  try {
    const parsed = parsePlanDocument(document({ coverage: 'Checkout Tests' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Checkout' });
    authored(store, [
      { kind: 'suite', do: 'Run checkout', area: 'Checkout Tests' },
      { kind: 'suite', do: 'Run login', area: 'Login Tests' },
    ]);
    assert.equal(
      store.listValidationChecks('issue:12')[0]?.area,
      'Checkout Tests',
      'the two-areas refusal went with the inheritance: a step names one, in an order the author chose',
    );
  } finally {
    store.close();
  }
});

test('with the area written, a sheet’s check row confirms and the run has a selector to carry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-join-e2e-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  const environments = [ACCEPTANCE];
  try {
    const parsed = parsePlanDocument(document({ coverage: 'Checkout Tests' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Checkout' });
    authored(store, [{ kind: 'suite', do: 'Run the checkout area', area: 'Checkout Tests' }]);
    store.recordGoalArrival({
      goalRef: 'issue:12',
      environment: 'acceptance',
      arrivedAt: new Date(NOW - 1000).toISOString(),
    });

    const desk = new RemoteValidationDesk({
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader: new FakeStateReader({}) }),
      runner: new FakeRemoteRunner({ acceptance: { listing: OFFERING } }),
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: 60_000,
      now: () => NOW,
    });
    await desk.run();

    const row = store.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.equal(row?.blockedReason, null, 'the pre-flight found the area the step named');
    assert.equal(row?.matched, 4, 'and counted the tests the runner attributes to it');
    assert.deepEqual(
      runnableSelectors(store, ACCEPTANCE, 'issue:12', store.listRemoteSheetRows()),
      ['Checkout Tests'],
      'which is the whole of what the browser half was missing: a selector to carry',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------- the cache

test('the desk lists what each runner offers, and keeps the answer where a planner is shown it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-offering-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  const runner = new FakeRemoteRunner({ acceptance: { listing: OFFERING } });
  const environments = [ACCEPTANCE];
  try {
    const desk = new RemoteValidationDesk({
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader: new FakeStateReader({}) }),
      runner,
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: 60_000,
      now: () => NOW,
    });
    await desk.run();
    assert.deepEqual(store.listOfferedAreas(), ['Checkout Tests', 'Login Tests']);
    assert.equal(runner.asked.length, 1, 'one spawn, with no goal in sight — the planner needs it before an arrival');

    await desk.run();
    assert.equal(runner.asked.length, 1, 'and it is paced to the suite’s rate of change rather than the pulse’s');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('a listing that could not say leaves the offering the last answer left standing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-offering-fail-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  const environments = [ACCEPTANCE];
  try {
    store.recordSelectorOffering('acceptance', [{ selector: 'Checkout Tests', tests: 4 }], '2020-01-01T00:00:00.000Z');
    const runner = new FakeRemoteRunner({ acceptance: { listingFailure: 'the command exited 1' } });
    const desk = new RemoteValidationDesk({
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader: new FakeStateReader({}) }),
      runner,
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: 60_000,
      now: () => NOW,
    });
    await desk.run();
    assert.equal(runner.asked.length, 1, 'the stale offering is re-asked');
    assert.deepEqual(
      store.listOfferedAreas(),
      ['Checkout Tests'],
      'and an unanswered listing is never an offering of nothing — that would refuse every coverage a planner names',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
