import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

/**
 * The fold that carries `findings` and `lessons` into `knowledge_facts` — the one
 * migration in this change, and the one whose two failure modes are exact
 * opposites and both silent.
 *
 * Every test below opens a **real file**, because that is the whole subject: an
 * in-memory database is fresh every time and could never tell a fold that runs
 * once from one that runs on every boot.
 */

const T0 = '2026-08-01T09:00:00.000Z';
const T1 = '2026-08-02T09:00:00.000Z';

/**
 * A database from the build before the merge: the two old tables, created and
 * filled by hand.
 *
 * The DDL is written out here rather than imported because it is **gone** —
 * `SCHEMA` no longer creates either table, since nothing reads them any more. That
 * is exactly what makes this the faithful fixture: a deployment taking this build
 * has these tables because an older build made them, and this is that database.
 */
const LEGACY_TABLES = `
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, origin_ref TEXT,
  kind TEXT NOT NULL, ref TEXT, summary TEXT NOT NULL, where_at TEXT, detail TEXT,
  status TEXT NOT NULL, job_id TEXT, ticket_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, origin_ref TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

function seed(
  dbPath: string,
  rows: { findings?: Record<string, unknown>[]; lessons?: Record<string, unknown>[] },
): void {
  // Opening the store once creates the schema *and* stamps the fold as done, which
  // is exactly wrong for a fixture — so the stamp is cleared before anything is
  // inserted, leaving a database that has the tables and has not been folded.
  new Store(dbPath).close();
  const db = new Database(dbPath);
  db.exec(LEGACY_TABLES);
  db.prepare(`DELETE FROM store_migrations`).run();
  for (const finding of rows.findings ?? []) {
    const cols = Object.keys(finding);
    db.prepare(`INSERT INTO findings (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(
      finding,
    );
  }
  for (const lesson of rows.lessons ?? []) {
    const cols = Object.keys(lesson);
    db.prepare(`INSERT INTO lessons (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(lesson);
  }
  db.close();
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'find_a',
    agent_id: 'agent_1',
    task_id: 'task_1',
    origin_ref: 'issue:41:plan',
    kind: 'out_of_scope',
    ref: 'pr:412',
    summary: 'The reap writer must be registered in two places.',
    where_at: 'src/branchReap.ts:12',
    detail: 'Registered it in one and the sweep silently stopped running.',
    status: 'open',
    job_id: null,
    ticket_ref: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function lesson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lesn_a',
    text: 'The suite wants a built web bundle first.',
    origin_ref: 'issue:41',
    status: 'proposed',
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function withDb(run: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-fold-'));
  try {
    run(join(dir, 'store.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('every finding and every lesson arrives as a fact, with the evidence behind it', () => {
  withDb((dbPath) => {
    seed(dbPath, { findings: [finding()], lessons: [lesson()] });
    const store = new Store(dbPath);
    const claims = store.listFacts().map((f) => f.claim);
    assert.ok(claims.includes('The reap writer must be registered in two places.'), 'the finding did not arrive');
    assert.ok(claims.includes('The suite wants a built web bundle first.'), 'the lesson did not arrive');

    // `where`/`ref` were already columns on a fact — `where_at` and `about_ref` —
    // so the fold is a copy rather than a translation, and the two coordinates an
    // operator reads together survive.
    const folded = store.listFacts().find((f) => f.claim.startsWith('The reap writer'))!;
    assert.equal(folded.where, 'src/branchReap.ts:12');
    assert.equal(folded.aboutRef, 'pr:412');
    // The goal it was seen on, and never the item it is about: those were two
    // different columns on a finding and they are two different columns on a fact.
    assert.equal(folded.originRef, 'issue:41:plan');
    assert.equal(folded.scope, 'fleet');
    assert.equal(folded.reach, 'proposal');
    // One voice, which is what a finding always was: one agent said it and nothing
    // agreed, so nothing may have auto-promoted on the way through.
    assert.equal(store.factCounts().get(folded.id)?.corroborations, 1);

    // The evidence is the corroboration's words — the agent's own account of what
    // it saw — and the kind rides in with it rather than becoming a column nothing
    // writes any more.
    const voice = store.listCorroborations(folded.id)[0]!;
    assert.match(voice.words, /out_of_scope/);
    assert.match(voice.words, /the sweep silently stopped running/);
    assert.equal(voice.agentId, 'agent_1');
    assert.equal(voice.taskId, 'task_1');
    // Counted by goal, so the dispatch concern is collapsed exactly as it is for
    // anything raised since.
    assert.equal(voice.goalRef, 'issue:41');
    store.close();
  });
});

test('the fold runs once, and a second boot does not undo what an operator ruled', () => {
  withDb((dbPath) => {
    seed(dbPath, { findings: [finding()], lessons: [lesson()] });
    const first = new Store(dbPath);
    const id = first.listFacts().find((f) => f.claim.startsWith('The reap writer'))!.id;
    // The operator reads it and says it is not true. Under a fold that ran on every
    // boot this is the row that comes back tomorrow as an unruled proposal — the
    // failure the named gate exists for, and one nothing would go red about.
    first.setFactReach(id, 'rejected');
    first.close();

    const second = new Store(dbPath);
    assert.equal(second.listFacts().length, 2, 'the fold ran twice');
    assert.equal(second.getFact(id)?.reach, 'rejected', 'the fold walked an operator’s ruling back');
    second.close();
  });
});

test('a dismissed finding is barred and a retired lesson is not', () => {
  withDb((dbPath) => {
    seed(dbPath, {
      findings: [finding({ id: 'find_dead', status: 'dismissed', summary: 'Not actually true.', updated_at: T1 })],
      lessons: [lesson({ id: 'lesn_old', status: 'retired', text: 'The old build step.', updated_at: T1 })],
    });
    const store = new Store(dbPath);
    const facts = new Map(store.listFacts().map((f) => [f.claim, f]));
    // Dismissing a finding already meant "an operator has answered this claim, and
    // a later report is not folded silently into it", which is the rejection bar
    // under the other store's name.
    assert.equal(facts.get('Not actually true.')?.reach, 'rejected');
    // And retiring a lesson meant the opposite — `lessons` said outright that a
    // lesson retired in error is written again. Folded to `rejected` it would be
    // refused by name forever, which is the one mapping in this migration that
    // could quietly take something away.
    assert.equal(facts.get('The old build step.')?.reach, 'retired');
    // Both were ruled on, and the stamp is what keeps them out of "Needs you".
    assert.equal(facts.get('Not actually true.')?.ruledAt, T1);
    assert.equal(facts.get('The old build step.')?.ruledAt, T1);
    store.close();
  });
});

test('a promoted lesson is the fact it was already mirrored into, not a second copy', () => {
  withDb((dbPath) => {
    seed(dbPath, { lessons: [lesson({ status: 'promoted', updated_at: T1 })] });
    // The mirror `adoptLessons` used to write on every boot, under the id the fold
    // derives too — which is the whole of why the fold cannot insert one again.
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO knowledge_facts
         (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, resolves_when,
          about_ref, where_at, created_at, updated_at)
       VALUES ('fact_lesn_a', ?, 'fleet', 'standing', NULL, 'injected', NULL, 'issue:41', ?, NULL, NULL, NULL, ?, ?)`,
    ).run('The suite wants a built web bundle first.', T1, T0, T1);
    db.prepare(
      `INSERT INTO knowledge_corroborations (id, fact_id, agent_id, task_id, goal_ref, session_id, words, created_at)
       VALUES ('knc_lesn_a', 'fact_lesn_a', NULL, NULL, 'issue:41', NULL, 'An operator vouched for this.', ?)`,
    ).run(T1);
    db.close();

    const store = new Store(dbPath);
    const facts = store.listFacts();
    assert.equal(facts.length, 1, 'the promoted lesson was folded in beside its own mirror');
    // Injected, which is what a promoted lesson has been since delivery moved: it
    // is in every agent's system prompt, and the fold must not demote it on the way
    // past.
    assert.equal(facts[0]!.reach, 'injected');
    // And one voice, not two: the mirror wrote a corroboration under an id derived
    // from the lesson's, and the fold uses the same derivation rather than adding
    // a second account of one operator vouching once.
    assert.equal(store.listCorroborations(facts[0]!.id).length, 1);
    store.close();
  });
});

test('what an operator already did about a finding becomes a graduation the sweep can finish', () => {
  withDb((dbPath) => {
    seed(dbPath, {
      findings: [
        finding({ id: 'find_job', status: 'promoted', job_id: 'job_1', summary: 'Work this now.', updated_at: T1 }),
        finding({ id: 'find_filing', status: 'filing', job_id: 'job_2', summary: 'File this one.', updated_at: T1 }),
        finding({
          id: 'find_filed',
          status: 'filed',
          job_id: 'job_3',
          ticket_ref: 'issue:314',
          summary: 'Already filed.',
          updated_at: T1,
        }),
      ],
    });
    const store = new Store(dbPath);
    const facts = new Map(store.listFacts().map((f) => [f.claim, f]));
    const rows = new Map(store.listGraduations().map((g) => [g.factId, g]));

    // A promoted finding stamped a status and never learned what became of the
    // job. Now it is an open graduation, which is a row the sweep reads.
    const job = rows.get(facts.get('Work this now.')!.id);
    assert.equal(job?.exit, 'job');
    assert.equal(job?.jobId, 'job_1');
    assert.equal(job?.outcome, null, 'a promoted finding arrived already settled');
    // The claim itself has not moved: a finding reached no agent at any status, and
    // an operator queueing work for one is not a ruling about how far it carries.
    assert.equal(facts.get('Work this now.')?.reach, 'proposal');

    // Filing was two statuses because it is asynchronous, and it still is — one
    // open row and one landed one, with the ticket on the landed one.
    assert.equal(rows.get(facts.get('File this one.')!.id)?.exit, 'ticket');
    assert.equal(rows.get(facts.get('File this one.')!.id)?.outcome, null);
    const filed = rows.get(facts.get('Already filed.')!.id);
    assert.equal(filed?.outcome, 'landed');
    assert.equal(filed?.ticketRef, 'issue:314');
    // And only that one is out of every prompt, because only that one actually
    // arrived somewhere.
    assert.equal(facts.get('Already filed.')?.reach, 'graduated');
    assert.equal(facts.get('File this one.')?.reach, 'proposal');

    // A `ticket` exit is not the graph sweep's to settle — `link_ticket` is what
    // ends one — so neither filing row is offered to it.
    assert.deepEqual(
      store.openGraduations().map((g) => g.exit),
      ['job'],
    );
    store.close();
  });
});

test('a finding from before the three-field split keeps its whole report as the claim', () => {
  withDb((dbPath) => {
    const blob =
      'The reap writer must be registered in two places.\n\nSeen in src/branchReap.ts, where the\nsweep stopped running silently.';
    seed(dbPath, { findings: [finding({ summary: blob, where_at: null, detail: null })] });
    const store = new Store(dbPath);
    // Verbatim, and no guess at where the seams were: the claim is matched against
    // other claims by its text, so a migration that split one would be inventing a
    // sentence nobody wrote and then matching on it.
    assert.equal(store.listFacts()[0]!.claim, blob);
    assert.equal(store.listFacts()[0]!.where, null);
    store.close();
  });
});

test('a database with nothing to fold is stamped anyway', () => {
  withDb((dbPath) => {
    // The stamp is about the run and not the rows. Without it a deployment with no
    // findings would re-read both tables on every boot forever — harmless today,
    // and exactly the shape that stops being harmless the moment anything writes
    // to those tables again.
    const store = new Store(dbPath);
    assert.deepEqual(store.listFacts(), []);
    store.close();
    const again = new Store(dbPath);
    assert.deepEqual(again.listFacts(), []);
    again.close();
  });
});
