import { test } from 'node:test';
import { commentSink } from './support/commentSink.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { validatePlanDocument, parsePlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { testPartNote } from '../src/plans/planning.js';
import { ValidationCheckSchema, validationCheckSetInputs } from '../src/validation/checkDocument.js';
import { stepArea, stepCapabilities } from '../src/validation/steps.js';
import { runnableSelectors } from '../src/remoteValidation/briefing.js';
import { validationPlanNote } from '../src/validation/authoring.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';

/*
 * How a check comes to have an area. The validation planner writes a `suite` step naming one, and
 * that step **is** the area: there is no column holding a copy of it, nothing pre-resolves it
 * against a listing at plan time, and what the pre-flight compares and the run's selectors are drawn
 * from is read back off the step. **A `covers` entry decides none of it**: it is a bibliography, and
 * while it was the join a check became automatable by accident.
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

// --------------------------------------------------------------- the coverage

test('the planner is asked to describe the coverage in words, and nothing is checked against a listing', () => {
  const note = testPartNote([ACCEPTANCE]);
  assert.match(note, /in words rather than as a file path/, 'it asks for prose');
  assert.match(note, /`coverage`/);
  assert.doesNotMatch(note, /copied exactly/, 'there is no list to copy from');
  assert.doesNotMatch(note, /character for character/);
});

test('a coverage naming anything at all is accepted, through both transports', () => {
  // The refusal this replaces is the whole of why a genuinely new area could not be declared: the
  // planner writes about code that does not exist yet, so there was never a listing that held it.
  const parsed = validatePlanDocument(JSON.parse(document({ coverage: 'checkout with a saved card' })));
  assert.equal(parsed.ok, true);
  const viaFile = parsePlanDocument(document({ coverage: 'an area no runner has ever offered' }));
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
  store.validation.ingestValidation('issue:12', {
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

test('a suite step names the area, and reading the check back gives it and nothing else does', () => {
  const store = new Store(':memory:');
  try {
    const parsed = parsePlanDocument(document({ coverage: 'Checkout Tests' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Checkout' });
    authored(store, [{ kind: 'suite', do: 'Run the checkout area', area: 'Checkout Tests' }]);

    const check = store.validation.listValidationChecks('issue:12')[0];
    assert.equal(
      stepArea(check?.steps ?? []),
      'Checkout Tests',
      'the string the run’s listing is compared against is read off the step, where its author wrote it',
    );
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

    const check = store.validation.listValidationChecks('issue:12')[0];
    assert.deepEqual(check?.covers, ['checkout-coverage'], 'the entry is kept — it says what the check exercises');
    assert.equal(
      stepArea(check?.steps ?? []),
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
    assert.equal(stepArea(store.validation.listValidationChecks('issue:12')[0]?.steps ?? []), null);
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
      stepArea(store.validation.listValidationChecks('issue:12')[0]?.steps ?? []),
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
    store.environments.recordGoalArrival({
      goalRef: 'issue:12',
      environment: 'acceptance',
      arrivedAt: new Date(NOW - 1000).toISOString(),
    });

    const desk = new RemoteValidationDesk({
      sink: commentSink(),
      validationRoot: dir,
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader: new FakeStateReader({}) }),
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: 60_000,
      now: () => NOW,
    });
    await desk.run();

    const row = store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.equal(row?.blockedReason, null, 'the area the step named is nothing the sheet blocks on');
    assert.equal(row?.matched, null, 'and the denominator is the run’s own listing to write, never assembly’s');
    assert.deepEqual(
      runnableSelectors(store, ACCEPTANCE, 'issue:12', store.remoteValidation.listRemoteSheetRows()),
      ['Checkout Tests'],
      'which is the whole of what the browser half was missing: a selector to carry',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ------------------------------------------------- nothing is pre-resolved at plan time

test('the harness takes no listing of its own, and keeps no offering to be shown one from', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-offering-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  const environments = [ACCEPTANCE];
  try {
    const desk = new RemoteValidationDesk({
      sink: commentSink(),
      validationRoot: dir,
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader: new FakeStateReader({}) }),
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: 60_000,
      now: () => NOW,
    });
    await desk.run();
    await desk.run();

    store.close();
    const inspect = new Database(file);
    const tables = (
      inspect.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((t) => t.name);
    inspect.close();
    assert.ok(
      !tables.includes('remote_selector_offerings'),
      'the cache is gone, and gone from the schema with it: left declared there it would be dropped and ' +
        'recreated empty on every boot, invisibly',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the planner is told what the deployment can drive, and no area to copy', () => {
  const note = validationPlanNote([ACCEPTANCE]);
  assert.match(note, /drives a browser/, 'the note names the step kinds this deployment can carry');
  assert.doesNotMatch(
    note,
    /Checkout Tests|last offered/,
    'and offers no area: an area picked from a listing taken in the harness’s own checkout is a guess about ' +
      'a commit the environment is not running, answered properly by the run’s own listing',
  );
  assert.match(
    note,
    /resolved against the deployed commit/,
    'so the planner is told where the name it writes is resolved instead',
  );
});
