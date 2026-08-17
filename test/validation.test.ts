import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanDocument, type PlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { nextCheckLetter } from '../src/validation/checkDocument.js';
import { ValidationAskDesk } from '../src/validation/askDesk.js';
import { Store } from '../src/store/store.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
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

/** Ingest, and hand back the **goal** — what the checks are keyed on. */
function ingest(store: Store, document: PlanDocument, originRef = 'issue:12'): string {
  ingestPlanDocument(store, { doc: document, originRef, title: 'Issue' });
  return originRef;
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
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
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
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
      reason: 'r',
      validation: { checks: [body] },
    });
    assert.equal(refused.ok, false, `a check with no ${missing} must be refused`);
  }
});

test('duplicate check ids are refused, because the id is the merge key', () => {
  const refused = validatePlanDocument({
    version: 1,
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
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
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
      reason: 'r',
      validation: { resources: [{ name }], checks: [] },
    });
    assert.equal(refused.ok, false, `"${name}" must be refused`);
  }
});

// -- ingestion ---------------------------------------------------------------

test('an unknown resource or part reference is dropped, never a refusal', () => {
  const store = new Store(':memory:');
  const goal = ingest(
    store,
    doc({
      parts: [{ slug: 'writer', title: 'Write it', scope: 'src/', dependsOn: [] }],
      validation: {
        resources: [{ name: 'fixture.tar.gz' }],
        checks: [check({ uses: ['fixture.tar.gz', 'nope.png'], covers: ['writer', 'ghost'] })],
      },
    }),
  );
  const [stored] = store.listValidationChecks(goal);
  // The prose is worth more than the bibliography: a planner that mistyped a
  // reference has still written a runnable check.
  assert.deepEqual(stored!.uses, ['fixture.tar.gz']);
  assert.deepEqual(stored!.covers, ['writer']);
});

test('a nomination keeps its reason, and a check without one keeps none', () => {
  const store = new Store(':memory:');
  const goal = ingest(
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
  const checks = store.listValidationChecks(goal);
  assert.equal(checks.find((c) => c.id === 'a')!.candidateWhy, 'runs git; no login');
  assert.equal(checks.find((c) => c.id === 'b')!.candidateWhy, null);
});

/** The document that declares one resource the planner cannot produce, and one it can. */
function withResources(): PlanDocument {
  return doc({
    validation: {
      resources: [
        { name: 'test-env login', kind: 'access', provided: false, note: 'a read-only account on staging' },
        { name: 'fixture.tar.gz', kind: 'fixture' },
      ],
      checks: [check()],
    },
  });
}

test('a resource the planner cannot provide is not an ask until the goal is delivered', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, withResources());
  const asks = new ValidationAskDesk(store);

  // The plan is in — and may still be `awaiting_approval`, and is certainly not
  // built. A check runs against the delivered goal, so there is nothing a person
  // could usefully do with this yet, and a row they cannot act on is the whole
  // cost of filing it early.
  asks.run();
  assert.equal(store.listHumanTasks().length, 0, 'nothing is delivered, so nothing is asked for');

  store.recordDelivery({ originRef: goal, summary: 'PR #40 landed it', by: 'assessor' });
  asks.run();
  const filed = store.listHumanTasks();
  assert.equal(filed.length, 1, 'only the unprovided one is an ask');
  assert.match(filed[0]!.title, /test-env login/);
  assert.match(filed[0]!.detail ?? '', /read-only account on staging/);
  assert.equal(store.listValidationResources(goal).find((r) => !r.provided)!.humanTaskId, filed[0]!.id);

  // The sweep runs every pulse, and a replan re-declaring the same resource must
  // not file it twice — the `recordHumanTask` refresh, carried across by name.
  asks.run();
  ingest(store, withResources());
  asks.run();
  assert.equal(store.listHumanTasks().length, 1);
});

test('an assessor that sends the goal back stops it being asked about', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, withResources());
  const asks = new ValidationAskDesk(store);
  store.recordShortfall({ originRef: goal, cause: 'goal', summary: 'the export is still wrong', by: 'assessor' });
  asks.run();
  assert.equal(store.listHumanTasks().length, 0, 'a shortfall is not a delivery — there is nothing to validate');

  // And the other order: a shortfall clears the delivery it contradicts, so the
  // gate closes again rather than the goal staying asked-about forever.
  store.recordDelivery({ originRef: goal, summary: 'delivered', by: 'assessor' });
  store.recordShortfall({ originRef: goal, cause: 'goal', summary: 'still wrong', by: 'assessor' });
  asks.run();
  assert.equal(store.listHumanTasks().length, 0);
});

test('a replan that stops needing a resource withdraws the ask it filed', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, withResources());
  store.recordDelivery({ originRef: goal, summary: 'delivered', by: 'assessor' });
  new ValidationAskDesk(store).run();
  const [filed] = store.listHumanTasks();
  assert.equal(filed?.status, 'open');

  // The resource row is replaced wholesale by the next document, so an ask nothing
  // withdraws is an obligation pointing at something no plan asks for — and one
  // the operator can never settle honestly.
  ingest(store, doc({ validation: { resources: [{ name: 'fixture.tar.gz', kind: 'fixture' }], checks: [check()] } }));
  const settled = store.getHumanTask(filed!.id);
  assert.equal(settled?.status, 'declined');
  assert.match(settled?.resolution ?? '', /no longer needs this/);
});

test('a planner that can produce the resource after all withdraws the ask too', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, withResources());
  store.recordDelivery({ originRef: goal, summary: 'delivered', by: 'assessor' });
  const asks = new ValidationAskDesk(store);
  asks.run();
  const [filed] = store.listHumanTasks();

  ingest(
    store,
    doc({
      validation: {
        resources: [{ name: 'test-env login', kind: 'access', provided: true }],
        checks: [check()],
      },
    }),
  );
  assert.equal(store.getHumanTask(filed!.id)?.status, 'declined');
  // And the next pulse does not put it straight back: the resource is provided.
  asks.run();
  assert.equal(store.listHumanTasks().filter((t) => t.status === 'open').length, 0);
});

test('a withdrawal never overwrites what the operator already answered', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, withResources());
  store.recordDelivery({ originRef: goal, summary: 'delivered', by: 'assessor' });
  new ValidationAskDesk(store).run();
  const [filed] = store.listHumanTasks();
  store.settleHumanTask(filed!.id, 'done', 'dropped it in the validation directory');

  ingest(store, doc({ validation: { resources: [], checks: [check()] } }));
  const settled = store.getHumanTask(filed!.id);
  assert.equal(settled?.status, 'done');
  assert.equal(settled?.resolution, 'dropped it in the validation directory');
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
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'first' }), check({ id: 'second' })] } }));
  const before = new Map(store.listValidationChecks(goal).map((c) => [c.id, c.letter]));
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
  const after = new Map(store.listValidationChecks(goal).map((c) => [c.id, c.letter]));
  assert.equal(after.get('first'), 'A');
  assert.equal(after.get('second'), 'B');
  assert.equal(after.get('third'), 'C');
});

// -- what an amendment may do ------------------------------------------------

test('a re-declared check keeps its result; a reworded one loses it', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'a' }), check({ id: 'b' })] } }));
  store.recordValidationResult(goal, 'a', { state: 'passed', note: 'opened fine', by: 'operator' });
  store.recordValidationResult(goal, 'b', { state: 'passed', note: 'opened fine', by: 'operator' });

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
  const checks = new Map(store.listValidationChecks(goal).map((c) => [c.id, c]));
  assert.equal(checks.get('a')!.state, 'passed');
  // An amendment that changes what a pass means has withdrawn the thing that was
  // confirmed — `acceptanceCriteria`'s rule, one layer up.
  assert.equal(checks.get('b')!.state, 'unrun');
  assert.equal(checks.get('b')!.resultNote, null);
  assert.equal(checks.get('b')!.resultAt, null);
});

test('a check an amendment drops is superseded, not deleted — and keeps its letter', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'a' }), check({ id: 'b' })] } }));
  ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));

  const checks = store.listValidationChecks(goal);
  assert.equal(checks.length, 2, 'the record survives the amendment');
  const dropped = checks.find((c) => c.id === 'b')!;
  assert.match(dropped.supersededReason!, /no longer includes this check/);

  // A new check takes C, not B: the letter is retired with the row.
  ingest(store, doc({ validation: { checks: [check({ id: 'a' }), check({ id: 'c' })] } }));
  assert.equal(store.listValidationChecks(goal).find((c) => c.id === 'c')!.letter, 'C');
});

test('a re-declared check comes back out of supersession', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  ingest(store, doc({ validation: { checks: [] } }));
  assert.ok(store.listValidationChecks(goal)[0]!.supersededReason);
  ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  const back = store.listValidationChecks(goal)[0]!;
  assert.equal(back.supersededReason, null);
  assert.equal(back.letter, 'A', 'and under the handle it always had');
});

test('an amendment with no validation block leaves the checks exactly as they are', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  store.recordValidationResult(goal, 'a', { state: 'passed', note: 'fine', by: 'operator' });
  // An operator override that never learned the block produces plans without one,
  // and reading that as "the planner withdrew every check" would supersede a plan
  // somebody is halfway through.
  ingest(store, doc());
  const [only] = store.listValidationChecks(goal);
  assert.equal(only!.state, 'passed');
  assert.equal(only!.supersededReason, null);
});

// -- results -----------------------------------------------------------------

test('a new reading clears what the last one left behind', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  store.recordValidationResult(goal, 'a', {
    state: 'deferred',
    note: 'the test environment is rebuilt on Thursday',
    by: 'operator',
    until: '2026-09-03',
  });
  const deferred = store.listValidationChecks(goal)[0]!;
  assert.equal(deferred.deferUntil, '2026-09-03');

  const passed = store.recordValidationResult(goal, 'a', { state: 'passed', note: 'ran it', by: 'operator' })!;
  // Otherwise the sheet renders "passed — the test environment is rebuilt on
  // Thursday", which is two readings wearing one row.
  assert.equal(passed.resultNote, 'ran it');
  assert.equal(passed.deferUntil, null);

  const reset = store.recordValidationResult(goal, 'a', { state: 'unrun', note: null, by: null })!;
  assert.equal(reset.resultNote, null);
  assert.equal(reset.resultBy, null);
  assert.equal(reset.resultAt, null, 'an unrun check carrying a timestamp reads as one that was run and forgotten');
});

test('a superseded check refuses a result — its plan has withdrawn it', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, doc({ validation: { checks: [check({ id: 'a' })] } }));
  ingest(store, doc({ validation: { checks: [] } }));
  assert.equal(store.recordValidationResult(goal, 'a', { state: 'passed', note: 'n', by: 'operator' }), null);
});

// -- the re-key: a database written before validation moved onto the goal ------

/**
 * The rebuild, on a database whose `validation_checks` and `validation_resources`
 * are still keyed on `plan_id`.
 *
 * **`id` and `letter` surviving is the whole assertion.** They are the merge key
 * and the handle a person types: a rebuild that renumbered either would silently
 * invalidate every amendment that names a check and every reading recorded
 * against one, with nothing failing to say so.
 */
test('an old database is rebuilt onto the goal, and the merge keys come through unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-rekey-'));
  const path = join(dir, 'old.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE plans (id TEXT PRIMARY KEY, origin_ref TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE validation_checks (
      plan_id TEXT NOT NULL, id TEXT NOT NULL, letter TEXT NOT NULL, seq INTEGER NOT NULL,
      title TEXT NOT NULL, check_do TEXT NOT NULL, check_expect TEXT NOT NULL, uses TEXT NOT NULL,
      covers TEXT NOT NULL, fleet_candidate INTEGER NOT NULL DEFAULT 0, candidate_why TEXT,
      actor TEXT, handback_note TEXT, claimed_by TEXT, claimed_at TEXT, state TEXT NOT NULL,
      result_note TEXT, result_by TEXT, result_at TEXT, defer_until TEXT, superseded_reason TEXT,
      revision TEXT, amended_at TEXT, amend_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, id));
    CREATE TABLE validation_resources (
      plan_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, note TEXT,
      provided INTEGER NOT NULL DEFAULT 1, human_task_id TEXT, PRIMARY KEY (plan_id, name));
    INSERT INTO plans VALUES ('plan_7', 'issue:7', 'Ship it', 'active', 'One PR.', '2026-01-01', '2026-01-01');
    INSERT INTO validation_checks VALUES
      ('plan_7', 'csv-opens', 'B', 1, 'The export opens', 'Export it.', 'It opens', '[]', '[]', 0, NULL,
       'fleet', NULL, NULL, NULL, 'passed', 'ran it', 'operator', '2026-01-02', NULL, NULL, NULL, NULL, NULL,
       '2026-01-01', '2026-01-02');
    INSERT INTO validation_resources VALUES ('plan_7', 'fixture.tar.gz', 'fixture', 'seeded', 0, 'task_1');
    INSERT INTO validation_checks VALUES
      ('plan_gone', 'orphan', 'A', 1, 'Nobody''s check', 'x', 'y', '[]', '[]', 0, NULL, NULL, NULL, NULL, NULL,
       'unrun', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01');
  `);
  db.close();

  const store = new Store(path);
  const [check] = store.listValidationChecks('issue:7');
  assert.ok(check, 'the check came across, keyed on the goal its plan named');
  assert.equal(check.id, 'csv-opens', 'the merge key is untouched');
  assert.equal(check.letter, 'B', 'and so is the handle a person types');
  assert.equal(check.state, 'passed');
  assert.equal(check.resultNote, 'ran it');
  assert.equal(check.actor, 'fleet', 'the hand-over survives too — it is an operator decision');
  const [resource] = store.listValidationResources('issue:7');
  assert.equal(resource?.name, 'fixture.tar.gz');
  assert.equal(resource?.humanTaskId, 'task_1', 'the ask already filed for it is still joined');
  // A row whose plan is gone can no longer name a goal, so it goes rather than
  // being carried under a key made up for it.
  assert.equal(store.listAllValidationChecks().length, 1);

  // Idempotent: the second boot finds the new shape and rebuilds nothing.
  store.close();
  const again = new Store(path);
  assert.equal(again.listValidationChecks('issue:7').length, 1);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});
