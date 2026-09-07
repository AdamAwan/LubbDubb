import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePlanDocument, planAtomInputs, planPartInputs } from '../src/plans/planDocument.js';
import { atomNote } from '../src/plans/atoms.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { PLAN_COLUMNS } from '../src/store/plans.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { PlanAtom, PlanPart } from '../src/types.js';
import type { PlanPartView } from '../src/wire.js';

(globalThis as { React?: typeof React }).React = React;

const { PlanModal } = await import('../web/src/components/PlanModal.js');
const { RefLinks } = await import('../web/src/components/refs.js');

interface AtomSeed {
  slug: string;
  title: string;
  intent: string;
  touches: string[];
  acceptance?: string;
  dependsOn: string[];
  rejected?: { route: string; because: string }[];
}

const CATALOG: AtomSeed = {
  slug: 'catalog-module',
  title: 'A catalog module that names every job type',
  intent: 'One place a payload schema can be looked up from.',
  touches: ['packages/jobs/src/catalog.ts'],
  acceptance: 'An unknown job type throws by name.',
  dependsOn: [],
  rejected: [{ route: 'Export a lookup map from each module.', because: 'The map and the modules can disagree.' }],
};

const MOVE: AtomSeed = {
  slug: 'move-schemas',
  title: 'Move the existing schemas into the catalog',
  intent: 'Behaviour-free: everything still imports them from where it did.',
  touches: ['packages/jobs/src/schemas/'],
  dependsOn: ['catalog-module'],
};

const ATOMS: AtomSeed[] = [CATALOG, MOVE];

function doc(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    reason: 'The catalog has to exist before anything can read it.',
    atoms: ATOMS,
    parts: [{ slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ATOMS.map((a) => a.slug) }],
    ...over,
  });
}

test('an atomless plan document parses exactly as it did before atoms existed', () => {
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'One reviewable change.',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/cache.ts', touches: ['src/cache.ts'] }],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.document.atoms : null, []);
  assert.deepEqual(parsed.ok ? planAtomInputs(parsed.document) : null, []);
  assert.deepEqual(parsed.ok ? planPartInputs(parsed.document)[0]?.atoms : null, []);
  assert.deepEqual(parsed.ok ? planPartInputs(parsed.document)[0]?.touches : null, ['src/cache.ts']);
});

test('every atom is carried by exactly one part — an orphan and a double are both refused, by name', () => {
  const orphan = parsePlanDocument(
    doc({ parts: [{ slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ['catalog-module'] }] }),
  );
  assert.equal(orphan.ok, false);
  assert.match(orphan.ok ? '' : orphan.error, /"move-schemas" is carried by no part/);

  const double = parsePlanDocument(
    doc({
      parts: [
        { slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ['catalog-module', 'move-schemas'] },
        { slug: 'again', title: 'Again', scope: 'packages/jobs', atoms: ['move-schemas'] },
      ],
    }),
  );
  assert.equal(double.ok, false);
  const error = double.ok ? '' : double.error;
  assert.match(error, /"move-schemas" is carried by "catalog" and "again"/);

  const unknown = parsePlanDocument(
    doc({
      parts: [
        {
          slug: 'catalog',
          title: 'The catalog',
          scope: 'packages/jobs',
          atoms: [...ATOMS.map((a) => a.slug), 'ghost'],
        },
      ],
    }),
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? '' : unknown.error, /carries unknown atom "ghost"/);
});

test('a grouping whose atom dependencies put two parts in a cycle is refused, naming both atoms and both parts', () => {
  const cyclic = parsePlanDocument(
    doc({
      atoms: [
        { ...CATALOG, dependsOn: ['move-schemas'] },
        { ...MOVE, dependsOn: ['catalog-module'] },
      ],
      parts: [
        { slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ['catalog-module'] },
        { slug: 'move', title: 'The move', scope: 'packages/jobs', atoms: ['move-schemas'] },
      ],
    }),
  );
  assert.equal(cyclic.ok, false);
  const error = cyclic.ok ? '' : cyclic.error;
  for (const named of ['catalog-module', 'move-schemas', '"catalog"', '"move"']) {
    assert.match(error, new RegExp(named.replace(/"/g, '"')), `the refusal never names ${named}`);
  }
  assert.match(error, /cycle/);

  // The same two atoms in one part are not a cycle: the dependency is inside the
  // merge boundary, which is exactly what grouping them was for.
  const grouped = parsePlanDocument(
    doc({
      atoms: [CATALOG, { ...MOVE, dependsOn: ['catalog-module'] }],
    }),
  );
  assert.equal(grouped.ok, true);
});

test('nothing refuses a plan for its atom count — one atom and eight are both plans', () => {
  const one = parsePlanDocument(
    doc({
      atoms: [CATALOG],
      parts: [{ slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ['catalog-module'] }],
    }),
  );
  assert.equal(one.ok, true);

  const many = Array.from({ length: 8 }, (_, i) => ({ ...CATALOG, slug: `atom-${i}`, dependsOn: [] }));
  const eight = parsePlanDocument(
    doc({
      atoms: many,
      parts: [{ slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: many.map((a) => a.slug) }],
    }),
  );
  assert.equal(eight.ok, true);
});

test("a part's touches derive from its atoms when it states none, so scope drift keeps working", () => {
  const derived = parsePlanDocument(doc());
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.ok ? planPartInputs(derived.document)[0]?.touches : null, [
    'packages/jobs/src/catalog.ts',
    'packages/jobs/src/schemas/',
  ]);

  const stated = parsePlanDocument(
    doc({
      parts: [
        {
          slug: 'catalog',
          title: 'The catalog',
          scope: 'packages/jobs',
          touches: ['packages/jobs/'],
          atoms: ATOMS.map((a) => a.slug),
        },
      ],
    }),
  );
  assert.equal(stated.ok, true);
  assert.deepEqual(stated.ok ? planPartInputs(stated.document)[0]?.touches : null, ['packages/jobs/']);
});

test("the planner's note asks for revertability rather than for small pieces", () => {
  const note = atomNote();
  assert.match(note, /rolled back on their own/);
  assert.match(note, /not better for having more atoms/);
  assert.ok(!/{atoms}/.test(note), 'the note is appended, never a placeholder a template override could drop');
});

test('atoms are stored with the plan, and an amended plan that drops one drops the row', () => {
  const system = buildSystem(planningConfig(), {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
  });
  const parsed = parsePlanDocument(doc());
  assert.equal(parsed.ok, true);
  const { plan } = ingestPlanDocument(system.store, {
    doc: parsed.ok ? parsed.document : (undefined as never),
    originRef: 'issue:390',
    title: 'Issue 390',
  });

  const stored = system.store.listAllPlanAtoms();
  assert.deepEqual(
    stored.map((a) => a.slug),
    ['catalog-module', 'move-schemas'],
  );
  const [first, second] = stored;
  assert.deepEqual(first?.rejected, CATALOG.rejected);
  assert.deepEqual(first?.touches, CATALOG.touches);
  assert.equal(second?.acceptance, null, 'an atom that states no acceptance reads back as stating none');
  assert.deepEqual(system.store.listPlanParts(plan.id)[0]?.atoms, ['catalog-module', 'move-schemas']);

  const amended = parsePlanDocument(
    doc({
      atoms: [CATALOG],
      parts: [{ slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ['catalog-module'] }],
    }),
  );
  assert.equal(amended.ok, true);
  ingestPlanDocument(system.store, {
    doc: amended.ok ? amended.document : (undefined as never),
    originRef: 'issue:390',
    title: 'Issue 390',
  });
  assert.deepEqual(
    system.store.listAllPlanAtoms().map((a) => a.slug),
    ['catalog-module'],
  );

  system.store.close();
});

test('a database from before atoms gains the column, reads null, and keeps every part it had', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-atoms-')), 'fleet.db');
  const old = new DatabaseCtor(path);
  old.exec(
    `CREATE TABLE plan_parts (
       id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, slug TEXT NOT NULL, seq INTEGER NOT NULL,
       title TEXT NOT NULL, scope TEXT NOT NULL, touches TEXT, rationale TEXT, acceptance TEXT,
       acceptance_met TEXT, size TEXT, expected_kind TEXT, profile TEXT, outcome_kind TEXT,
       outcome_ref TEXT, outcome_summary TEXT, depends_on TEXT NOT NULL, branch TEXT, pr_number INTEGER,
       status TEXT NOT NULL, blocked_reason TEXT, blocked_by TEXT, task_id TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (plan_id, slug));
     INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, touches, depends_on, status, created_at, updated_at)
     VALUES ('plan-1:whole', 'plan-1', 'whole', 1, 'The change', 'src/', '["src/"]', '[]', 'ready', 'then', 'then');`,
  );
  old.close();

  const store = new Store(path);
  const raw = new DatabaseCtor(path, { readonly: true });
  const columns = (raw.prepare(`PRAGMA table_info(plan_parts)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes('atoms'), 'the additive ALTER TABLE never ran');
  const row = raw.prepare(`SELECT atoms FROM plan_parts WHERE id=?`).get('plan-1:whole') as { atoms: unknown };
  assert.equal(row.atoms, null, 'nothing was written into the column for a plan that predates atoms');
  raw.close();

  const part = store.listAllPlanParts().find((p) => p.id === 'plan-1:whole');
  assert.ok(part, 'the pre-atoms part is still readable');
  assert.equal(part.atoms, undefined, 'null means this plan predates atoms — nothing is invented for it');
  assert.deepEqual(part.touches, ['src/'], 'and it keeps everything it did declare');
  assert.deepEqual(store.listAllPlanAtoms(), []);
  assert.ok(PLAN_COLUMNS.plan_atoms, 'plan_atoms carries its ColumnMigrations entry from day one');

  store.close();
});

test('the plan sheet draws a part’s atoms, and a part without them is unchanged', () => {
  const withAtoms = sheet(part({ slug: 'catalog', atoms: ['catalog-module', 'move-schemas'] }), [
    atom(CATALOG),
    atom(MOVE),
  ]);
  assert.match(withAtoms, /2 atoms/);
  assert.ok(withAtoms.includes('A catalog module that names every job type'));
  assert.ok(withAtoms.includes('One place a payload schema can be looked up from.'));
  assert.ok(withAtoms.includes('packages/jobs/src/catalog.ts'), 'the paths an atom claims are drawn');
  assert.ok(withAtoms.includes('Export a lookup map from each module.'), 'the route it did not take is drawn');
  assert.ok(withAtoms.includes('The map and the modules can disagree.'));
  const block = withAtoms.slice(withAtoms.indexOf('pm-atoms'), withAtoms.indexOf('pm-stack'));
  assert.ok(!block.includes('<button'), 'atoms are read-only on this sheet — nothing here is a control');
  assert.ok(!block.includes('<input'), 'atoms are read-only on this sheet — nothing here is editable');

  const without = sheet(part({ slug: 'catalog' }), []);
  assert.ok(!without.includes('pm-atoms'), 'a part with no atoms draws exactly what it drew before');
  assert.ok(without.includes('The catalog'), 'and still draws itself');
});

function sheet(one: PlanPartView, atoms: PlanAtom[]): string {
  return renderToStaticMarkup(
    createElement(
      RefLinks,
      {
        refUrls: {},
        openGoal: () => undefined,
        hasGoal: () => false,
        openPr: () => undefined,
        hasPr: () => false,
      } as unknown as Parameters<typeof RefLinks>[0],
      createElement(PlanModal, {
        plan: {
          id: 'plan-390',
          originRef: 'issue:390',
          title: 'Validate every payload',
          status: 'awaiting_approval',
          reason: 'The catalog has to exist first.',
          diagnosis: null,
          approach: null,
          risks: null,
          outOfScope: null,
          alternatives: null,
          openQuestions: null,
          verification: null,
          evidence: [],
          document: null,
          statusCommentRef: null,
          createdAt: 'then',
          updatedAt: 'then',
        },
        parts: [one],
        atoms,
        checks: [],
        caveatAnswers: [],
        watches: [],
        upcoming: [],
        spend: null,
        planning: { fileBudget: 20, maxConcurrentPartsPerIssue: 2 },
        now: Date.now(),
        refUrls: {},
        onClose: () => undefined,
        onReplan: () => undefined,
        onWatchProposal: () => undefined,
        onDecide: () => undefined,
        onBackOut: () => undefined,
        onOpenGoal: () => undefined,
        onPartProfile: () => undefined,
        onRestartPart: () => undefined,
        canClosePr: false,
        profiles: [],
        defaultProfile: null,
        desktopFolder: '/home/you/shop',
      } as unknown as Parameters<typeof PlanModal>[0]),
    ),
  );
}

function part(over: Partial<PlanPart> & { slug: string }): PlanPartView {
  return {
    id: `plan-390:${over.slug}`,
    planId: 'plan-390',
    seq: 1,
    title: 'The catalog',
    scope: 'packages/jobs',
    touches: [],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    profile: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: 'then',
    updatedAt: 'then',
    depth: 0,
    acceptanceCriteria: [],
    outsideScope: [],
    ...over,
  };
}

function atom(seed: AtomSeed): PlanAtom {
  return {
    id: `plan-390:${seed.slug}`,
    planId: 'plan-390',
    seq: 1,
    acceptance: seed.acceptance ?? null,
    rejected: seed.rejected ?? [],
    ...seed,
  };
}

function planningConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-plan-atoms-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}
