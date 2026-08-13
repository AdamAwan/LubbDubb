import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanDocument, type PlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { nextCheckLetter } from '../src/validation/checkDocument.js';
import { Store } from '../src/store/store.js';

/**
 * The validation plan as it becomes rows: the schema's refusals, the letters, and
 * what an amendment is allowed to do to a check somebody has already run.
 *
 * The property worth holding on to while reading these: **a check's identity is
 * its id, its handle is its letter, and neither is its position.** Everything
 * below is a way that could quietly stop being true.
 */

function doc(over: Record<string, unknown> = {}): PlanDocument {
  const parsed = validatePlanDocument({
    version: 1,
    verdict: 'single',
    reason: 'One small fix.',
    ...over,
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.document;
}

function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'csv-opens-in-excel',
    title: 'The export opens in Excel',
    do: 'Export a report and open the file.',
    expect: 'It opens with the columns intact.',
    ...over,
  };
}

function ingest(store: Store, document: PlanDocument, originRef = 'issue:12'): string {
  return ingestPlanDocument(store, { doc: document, originRef, title: 'Issue', validationEnabled: true }).plan.id;
}

// -- the schema --------------------------------------------------------------

test('a validation block is optional, and absent is not the same as empty', () => {
  const plain = doc();
  assert.equal(plain.validation, undefined);
  const empty = doc({ validation: { checks: [] } });
  assert.deepEqual(empty.validation, { checks: [], resources: [] });
});

test('a check carrying an actor is refused rather than ignored', () => {
  const refused = validatePlanDocument({
    version: 1,
    verdict: 'single',
    reason: 'r',
    validation: { checks: [check({ actor: 'fleet' })] },
  });
  assert.equal(refused.ok, false);
  // Named, so the planner can act on it: silently dropping the field is what
  // would let one believe it had assigned work to a fleet with no browser.
  assert.match(refused.ok ? '' : refused.error, /who runs it is not yours to say/);
});

test('a check with no expectation is refused — that is what makes it a check', () => {
  for (const missing of ['title', 'do', 'expect']) {
    const body = check();
    delete body[missing];
    const refused = validatePlanDocument({
      version: 1,
      verdict: 'single',
      reason: 'r',
      validation: { checks: [body] },
    });
    assert.equal(refused.ok, false, `a check with no ${missing} must be refused`);
  }
});

test('duplicate check ids are refused, because the id is the merge key', () => {
  const refused = validatePlanDocument({
    version: 1,
    verdict: 'single',
    reason: 'r',
    validation: { checks: [check(), check({ title: 'Something else' })] },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /duplicate check id/);
});

test('a resource name is a file name — a path is refused rather than sanitised', () => {
  for (const name of ['../secrets.env', 'nested/fixture.tar.gz', '..']) {
    const refused = validatePlanDocument({
      version: 1,
      verdict: 'single',
      reason: 'r',
      validation: { resources: [{ name }], checks: [] },
    });
    assert.equal(refused.ok, false, `"${name}" must be refused`);
  }
});

// -- ingestion ---------------------------------------------------------------

test('an unknown resource or part reference is dropped, never a refusal', () => {
  const store = new Store(':memory:');
  const planId = ingest(
    store,
    doc({
      verdict: 'parts',
      parts: [{ slug: 'writer', title: 'Write it', scope: 'src/', dependsOn: [] }],
      validation: {
        resources: [{ name: 'fixture.tar.gz' }],
        checks: [check({ uses: ['fixture.tar.gz', 'nope.png'], covers: ['writer', 'ghost'] })],
      },
    }),
  );
  const [stored] = store.listValidationChecks(planId);
  // The prose is worth more than the bibliography: a planner that mistyped a
  // reference has still written a runnable check.
  assert.deepEqual(stored!.uses, ['fixture.tar.gz']);
  assert.deepEqual(stored!.covers, ['writer']);
});

test('a nomination keeps its reason, and a check without one keeps none', () => {
  const store = new Store(':memory:');
  const planId = ingest(
    store,
    doc({
      validation: {
        checks: [
          check({ id: 'a', fleetCandidate: true, why: 'runs git; no login' }),
          // `why` with no nomination would render as a nomination the sheet is
          // failing to draw.
          check({ id: 'b', why: 'stranded reason' }),
        ],
      },
    }),
  );
  const checks = store.listValidationChecks(planId);
  assert.equal(checks.find((c) => c.id === 'a')!.candidateWhy, 'runs git; no login');
  assert.equal(checks.find((c) => c.id === 'b')!.candidateWhy, null);
});

test('a resource the planner cannot provide files an ask, once', () => {
  const store = new Store(':memory:');
  const document = doc({
    validation: {
      resources: [
        { name: 'test-env login', kind: 'access', provided: false, note: 'a read-only account on staging' },
        { name: 'fixture.tar.gz', kind: 'fixture' },
      ],
      checks: [check()],
    },
  });
  const planId = ingest(store, document);
  const asks = store.listHumanTasks();
  assert.equal(asks.length, 1, 'only the unprovided one is an ask');
  assert.match(asks[0]!.title, /test-env login/);
  assert.match(asks[0]!.detail ?? '', /read-only account on staging/);
  assert.equal(store.listValidationResources(planId).find((r) => !r.provided)!.humanTaskId, asks[0]!.id);

  // A replan re-declaring the same resource must not file it twice — the
  // `recordHumanTask` refresh, carried across by name.
  ingest(store, document);
  assert.equal(store.listHumanTasks().length, 1);
});

test('validation.enabled off ingests nothing at all', () => {
  const store = new Store(':memory:');
  const plan = ingestPlanDocument(store, {
    doc: doc({ validation: { checks: [check()] } }),
    originRef: 'issue:12',
    title: 'Issue',
  });
  assert.deepEqual(store.listValidationChecks(plan.plan.id), []);
});

// -- letters -----------------------------------------------------------------

test('nextCheckLetter walks A..Z and then AA, skipping what is taken', () => {
  assert.equal(nextCheckLetter([]), 'A');
  assert.equal(nextCheckLetter(['A', 'B']), 'C');
  // It fills the lowest free letter, which is safe only because nothing ever
  // frees one: a dropped check keeps its row and therefore its letter, so the
  // "taken" list this is asked about has no gaps in practice. The
  // supersession test below is what actually holds `284:B` still.
  assert.equal(nextCheckLetter(['A', 'C']), 'B');
  const alphabet = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  assert.equal(nextCheckLetter(alphabet), 'AA');
  assert.equal(nextCheckLetter([...alphabet, 'AA']), 'AB');
});

test('letters are assigned in declaration order and survive a reordering amendment', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'first' }), check({ id: 'second' })] } }));
  const before = new Map(store.listValidationChecks(planId).map((c) => [c.id, c.letter]));
  assert.deepEqual(
    [...before],
    [
      ['first', 'A'],
      ['second', 'B'],
    ],
  );

  // The same two checks, declared the other way round, plus a new one. Position
  // moved; the handle did not.
  ingest(
    store,
    doc({ validation: { checks: [check({ id: 'second' }), check({ id: 'third' }), check({ id: 'first' })] } }),
  );
  const after = new Map(store.listValidationChecks(planId).map((c) => [c.id, c.letter]));
  assert.equal(after.get('first'), 'A');
  assert.equal(after.get('second'), 'B');
  assert.equal(after.get('third'), 'C');
});

// -- what an amendment may do ------------------------------------------------

test('a re-declared check keeps its result; a reworded one loses it', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'a' }), check({ id: 'b' })] } }));
  store.recordValidationResult(planId, 'a', { state: 'passed', note: 'opened fine', by: 'operator' });
  store.recordValidationResult(planId, 'b', { state: 'passed', note: 'opened fine', by: 'operator' });

  ingest(
    store,
    doc({
      validation: {
        checks: [
          // Untouched wording, plus a corrected reference — not a rewording, and
          // a result carried across it is still a result about the same check.
          check({ id: 'a', covers: [] }),
          check({ id: 'b', expect: 'It opens with the columns intact **and in order**.' }),
        ],
      },
    }),
  );
  const checks = new Map(store.listValidationChecks(planId).map((c) => [c.id, c]));
  assert.equal(checks.get('a')!.state, 'passed');
  // An amendment that changes what a pass means has withdrawn the thing that was
  // confirmed — `acceptanceCriteria`'s rule, one layer up.
  assert.equal(checks.get('b')!.state, 'unrun');
  assert.equal(checks.get('b')!.resultNote, null);
  assert.equal(checks.get('b')!.resultAt, null);
});

test('a check an amendment drops is superseded, not deleted — and keeps its letter', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'a' }), check({ id: 'b' })] } }));
  ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));

  const checks = store.listValidationChecks(planId);
  assert.equal(checks.length, 2, 'the record survives the amendment');
  const dropped = checks.find((c) => c.id === 'b')!;
  assert.match(dropped.supersededReason!, /no longer includes this check/);

  // A new check takes C, not B: the letter is retired with the row.
  ingest(store, doc({ validation: { checks: [check({ id: 'a' }), check({ id: 'c' })] } }));
  assert.equal(store.listValidationChecks(planId).find((c) => c.id === 'c')!.letter, 'C');
});

test('a re-declared check comes back out of supersession', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  ingest(store, doc({ validation: { checks: [] } }));
  assert.ok(store.listValidationChecks(planId)[0]!.supersededReason);
  ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  const back = store.listValidationChecks(planId)[0]!;
  assert.equal(back.supersededReason, null);
  assert.equal(back.letter, 'A', 'and under the handle it always had');
});

test('an amendment with no validation block leaves the checks exactly as they are', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  store.recordValidationResult(planId, 'a', { state: 'passed', note: 'fine', by: 'operator' });
  // An operator override that never learned the block produces plans without one,
  // and reading that as "the planner withdrew every check" would supersede a plan
  // somebody is halfway through.
  ingest(store, doc());
  const [only] = store.listValidationChecks(planId);
  assert.equal(only!.state, 'passed');
  assert.equal(only!.supersededReason, null);
});

// -- results -----------------------------------------------------------------

test('a new reading clears what the last one left behind', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  store.recordValidationResult(planId, 'a', {
    state: 'deferred',
    note: 'the test environment is rebuilt on Thursday',
    by: 'operator',
    until: '2026-09-03',
  });
  const deferred = store.listValidationChecks(planId)[0]!;
  assert.equal(deferred.deferUntil, '2026-09-03');

  const passed = store.recordValidationResult(planId, 'a', { state: 'passed', note: 'ran it', by: 'operator' })!;
  // Otherwise the sheet renders "passed — the test environment is rebuilt on
  // Thursday", which is two readings wearing one row.
  assert.equal(passed.resultNote, 'ran it');
  assert.equal(passed.deferUntil, null);

  const reset = store.recordValidationResult(planId, 'a', { state: 'unrun', note: null, by: null })!;
  assert.equal(reset.resultNote, null);
  assert.equal(reset.resultBy, null);
  assert.equal(reset.resultAt, null, 'an unrun check carrying a timestamp reads as one that was run and forgotten');
});

test('a superseded check refuses a result — its plan has withdrawn it', () => {
  const store = new Store(':memory:');
  const planId = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  ingest(store, doc({ validation: { checks: [] } }));
  assert.equal(store.recordValidationResult(planId, 'a', { state: 'passed', note: 'n', by: 'operator' }), null);
});
