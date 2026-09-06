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

function ingest(store: Store, document: PlanDocument, originRef = 'issue:12'): string {
  ingestPlanDocument(store, { doc: document, originRef, title: 'Issue' });
  return originRef;
}

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
          check({ id: 'b', why: 'stranded reason' }),
        ],
      },
    }),
  );
  const checks = store.listValidationChecks(goal);
  assert.equal(checks.find((c) => c.id === 'a')!.candidateWhy, 'runs git; no login');
  assert.equal(checks.find((c) => c.id === 'b')!.candidateWhy, null);
});

function withResources(): PlanDocument {
  return doc({
    validation: {
      resources: [
        { name: 'orders-dump.sql', kind: 'data', provided: false, note: 'a week of real orders, scrubbed' },
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

  asks.run();
  assert.equal(store.listHumanTasks().length, 0, 'nothing is delivered, so nothing is asked for');

  store.recordDelivery({ originRef: goal, summary: 'PR #40 landed it', by: 'assessor' });
  asks.run();
  const filed = store.listHumanTasks();
  assert.equal(filed.length, 1, 'only the unprovided one is an ask');
  assert.match(filed[0]!.title, /orders-dump\.sql/);
  assert.match(filed[0]!.detail ?? '', /week of real orders/);
  assert.equal(store.listValidationResources(goal).find((r) => !r.provided)!.humanTaskId, filed[0]!.id);

  asks.run();
  ingest(store, withResources());
  asks.run();
  assert.equal(store.listHumanTasks().length, 1);
});

test('a resource naming access rather than a file is never an ask', () => {
  const store = new Store(':memory:');
  const goal = ingest(
    store,
    doc({
      validation: {
        resources: [
          { name: 'staging-login', kind: 'access', provided: false, note: 'a read-only account on staging' },
          { name: 'orders-dump.sql', kind: 'data', provided: false },
        ],
        checks: [check()],
      },
    }),
  );
  store.recordDelivery({ originRef: goal, summary: 'delivered', by: 'assessor' });
  new ValidationAskDesk(store).run();

  const filed = store.listHumanTasks();
  assert.equal(filed.length, 1);
  assert.match(filed[0]!.title, /orders-dump\.sql/);
  assert.equal(store.listValidationResources(goal).find((r) => r.kind === 'access')!.humanTaskId, null);
});

test('an assessor that sends the goal back stops it being asked about', () => {
  const store = new Store(':memory:');
  const goal = ingest(store, withResources());
  const asks = new ValidationAskDesk(store);
  store.recordShortfall({ originRef: goal, cause: 'goal', summary: 'the export is still wrong', by: 'assessor' });
  asks.run();
  assert.equal(store.listHumanTasks().length, 0, 'a shortfall is not a delivery — there is nothing to validate');

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
        resources: [{ name: 'orders-dump.sql', kind: 'data', provided: true }],
        checks: [check()],
      },
    }),
  );
  assert.equal(store.getHumanTask(filed!.id)?.status, 'declined');
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

test('nextCheckLetter walks A..Z and then AA, skipping what is taken', () => {
  assert.equal(nextCheckLetter([]), 'A');
  assert.equal(nextCheckLetter(['A', 'B']), 'C');
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

  ingest(
    store,
    doc({ validation: { checks: [check({ id: 'second' }), check({ id: 'third' }), check({ id: 'first' })] } }),
  );
  const after = new Map(store.listValidationChecks(goal).map((c) => [c.id, c.letter]));
  assert.equal(after.get('first'), 'A');
  assert.equal(after.get('second'), 'B');
  assert.equal(after.get('third'), 'C');
});

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
          check({ id: 'a', covers: [] }),
          check({ id: 'b', expect: 'It opens with the columns intact **and in order**.' }),
        ],
      },
    }),
  );
  const checks = new Map(store.listValidationChecks(goal).map((c) => [c.id, c]));
  assert.equal(checks.get('a')!.state, 'passed');
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
  ingest(store, doc());
  const [only] = store.listValidationChecks(goal);
  assert.equal(only!.state, 'passed');
  assert.equal(only!.supersededReason, null);
});

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
  assert.equal(store.listAllValidationChecks().length, 1);

  store.close();
  const again = new Store(path);
  assert.equal(again.listValidationChecks('issue:7').length, 1);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});
