import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { regroupedDocument, regroupRefusal } from '../src/plans/regroup.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { System } from '../src/system.js';
import type { PlanAtom, PlanPart } from '../src/types.js';
import type { PlanPartView } from '../src/wire.js';

(globalThis as { React?: typeof React }).React = React;

const { PlanModal } = await import('../web/src/components/PlanModal.js');
const { PlanRegroup } = await import('../web/src/components/PlanRegroup.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { regroupCycle, groupingCost, initialGrouping, moveAtom } = await import('../web/src/cockpit/regroup.js');

const ORIGIN = 'issue:412';

const ATOMS = [
  {
    slug: 'catalog-module',
    title: 'A catalog module that names every job type',
    intent: 'One place a payload schema can be looked up from.',
    touches: ['packages/jobs/src/catalog.ts'],
    dependsOn: [] as string[],
    rejected: [{ route: 'Export a lookup map from each module.', because: 'The map and the modules can disagree.' }],
  },
  {
    slug: 'move-schemas',
    title: 'Move the existing schemas into the catalog',
    intent: 'Behaviour-free: everything still imports them from where it did.',
    touches: ['packages/jobs/src/schemas/'],
    dependsOn: ['catalog-module'],
  },
  {
    slug: 'validate-at-the-door',
    title: 'Validate every payload as it arrives',
    intent: 'The behaviour the goal actually asked for.',
    touches: ['packages/jobs/src/queue.ts'],
    dependsOn: ['catalog-module'],
  },
];

function planDocument(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    reason: 'The catalog has to exist before anything can read it.',
    atoms: ATOMS,
    parts: [
      {
        slug: 'catalog',
        title: 'The catalog',
        scope: 'A module every job type is named in',
        atoms: ['catalog-module', 'move-schemas'],
      },
      {
        slug: 'validate',
        title: 'Validation at the door',
        scope: 'Every payload is checked as it arrives',
        atoms: ['validate-at-the-door'],
        dependsOn: ['catalog'],
      },
    ],
    ...over,
  });
}

function planned(system: System, raw = planDocument()): { plan: ReturnType<typeof plannedPlan> } {
  const parsed = parsePlanDocument(raw);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, {
    doc: parsed.ok ? parsed.document : (undefined as never),
    originRef: ORIGIN,
    title: 'Validate every payload',
  });
  return { plan: plannedPlan(system) };
}

function plannedPlan(system: System) {
  const plan = system.store.getPlanByOrigin(ORIGIN);
  assert.ok(plan, 'the plan was not stored');
  return plan;
}

function held(system: System): { parts: PlanPart[]; atoms: PlanAtom[] } {
  const plan = plannedPlan(system);
  return {
    parts: system.store.listPlanParts(plan.id),
    atoms: system.store.listAllPlanAtoms().filter((a) => a.planId === plan.id),
  };
}

test('a regroup writes a document the schema accepts, and the atoms come through the move unchanged', () => {
  const system = harness();
  planned(system);
  const before = held(system);
  const slugs = before.atoms.map((a) => a.slug);

  const regrouped = regroupedDocument({
    plan: plannedPlan(system),
    parts: before.parts,
    atoms: before.atoms,
    groups: [
      { slug: 'catalog', atoms: ['catalog-module'] },
      { slug: 'validate', atoms: ['move-schemas', 'validate-at-the-door'] },
    ],
  });
  assert.equal(regrouped.ok, true, regrouped.ok ? '' : regrouped.error);
  if (!regrouped.ok) return;

  ingestPlanDocument(system.store, { doc: regrouped.document, originRef: ORIGIN, title: 'Validate every payload' });
  const after = held(system);

  assert.deepEqual(
    after.atoms.map((a) => a.slug),
    slugs,
    'an atom must keep its slug across a regroup',
  );
  assert.deepEqual(
    after.atoms.map((a) => a.title),
    before.atoms.map((a) => a.title),
    'and everything else it declares',
  );
  assert.deepEqual(after.parts.find((p) => p.slug === 'catalog')?.atoms, ['catalog-module']);
  assert.deepEqual(after.parts.find((p) => p.slug === 'validate')?.atoms, ['move-schemas', 'validate-at-the-door']);
  assert.deepEqual(
    after.parts.find((p) => p.slug === 'validate')?.dependsOn,
    ['catalog'],
    'the moved atoms still wait on the part carrying what they depend on',
  );
  assert.deepEqual(
    after.parts.find((p) => p.slug === 'validate')?.touches,
    ['packages/jobs/src/schemas/', 'packages/jobs/src/queue.ts'],
    'a part whose touches were derived re-derives them from the atoms it now carries',
  );
  assert.equal(plannedPlan(system).status, 'awaiting_approval', 'a regroup schedules nothing');

  system.store.close();
});

test('a regroup that puts two parts in a cycle is refused, naming both atoms and both parts', () => {
  const system = harness();
  planned(
    system,
    planDocument({
      atoms: [{ ...ATOMS[0], dependsOn: ['validate-at-the-door'] }, ATOMS[1], ATOMS[2]],
      parts: [
        {
          slug: 'catalog',
          title: 'The catalog',
          scope: 'A module every job type is named in',
          atoms: ['catalog-module', 'move-schemas', 'validate-at-the-door'],
        },
      ],
    }),
  );
  const { parts, atoms } = held(system);

  const groups = [
    { slug: 'catalog', atoms: ['catalog-module', 'move-schemas'] },
    { slug: 'validate', atoms: ['validate-at-the-door'], title: 'Validation at the door', scope: 'Payloads checked' },
  ];
  const refused = regroupedDocument({ plan: plannedPlan(system), parts, atoms, groups });
  assert.equal(refused.ok, false);
  const error = refused.ok ? '' : refused.error;
  for (const named of ['catalog-module', 'validate-at-the-door', 'catalog', 'validate', 'cycle']) {
    assert.match(error, new RegExp(named), `the harness's refusal never names ${named}`);
  }

  // The same refusal where the operator will actually read it: on the surface,
  // before the save it blocks.
  const cycle = regroupCycle(
    atoms,
    groups.map((g) => ({ slug: g.slug, title: g.slug, scope: g.slug, atoms: g.atoms, added: false })),
  );
  assert.ok(cycle, 'the surface draws no cycle where the harness would refuse one');
  for (const named of ['catalog-module', 'validate-at-the-door', 'catalog', 'validate']) {
    assert.ok(cycle.sentence.includes(named), `what the operator reads never names ${named}`);
  }
  assert.match(cycle.sentence, /Move/, 'and it says what to move');

  const drawn = renderToStaticMarkup(
    createElement(PlanRegroup, {
      parts: parts.map(asView),
      atoms,
      onRegroup: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.ok(!drawn.includes('wait on each other'), 'the plan as stored is not itself a cycle');

  system.store.close();
});

test('the route regroups an awaiting-approval plan in place, and the sheet offers it', async () => {
  const system = harness();
  planned(system);
  const plan = plannedPlan(system);
  const { app } = await buildApp(system);

  const drawn = sheet({
    parts: system.store.listPlanParts(plan.id).map(asView),
    atoms: held(system).atoms,
    status: 'awaiting_approval',
  });
  assert.ok(drawn.includes('>Regroup<'), 'a plan with atoms, still awaiting approval, offers the regroup');

  const res = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/regroup`,
    payload: {
      groups: [
        { slug: 'catalog', atoms: ['catalog-module'] },
        { slug: 'validate', atoms: ['move-schemas', 'validate-at-the-door'] },
      ],
    },
  });
  assert.equal(res.statusCode, 200, res.body);

  const after = held(system);
  assert.deepEqual(after.parts.find((p) => p.slug === 'catalog')?.atoms, ['catalog-module']);
  assert.deepEqual(
    after.atoms.map((a) => a.slug),
    ATOMS.map((a) => a.slug),
    'the atoms are exactly the ones that went in',
  );
  assert.equal(plannedPlan(system).status, 'awaiting_approval');

  const cyclic = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/regroup`,
    payload: {
      groups: [
        { slug: 'catalog', atoms: ATOMS.map((a) => a.slug) },
        { slug: 'validate', atoms: [] },
      ],
    },
  });
  assert.equal(cyclic.statusCode, 200, 'moving every atom into one part is a grouping, not a refusal');

  await app.close();
  system.store.close();
});

test('a plan that declares no atoms offers no regroup at all, and is refused one', () => {
  const system = harness();
  planned(
    system,
    JSON.stringify({
      version: 1,
      reason: 'One reviewable change.',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/cache.ts', touches: ['src/cache.ts'] }],
    }),
  );
  const { parts, atoms } = held(system);
  assert.deepEqual(atoms, []);

  const refusal = regroupRefusal(plannedPlan(system), parts, atoms);
  assert.match(refusal ?? '', /declares no atoms/);

  const drawn = sheet({ parts: parts.map(asView), atoms, status: 'awaiting_approval' });
  assert.ok(!drawn.includes('>Regroup<'), 'a plan with no atoms must not offer a regroup');

  system.store.close();
});

test('a part in flight is not regrouped — the surface does not offer it and the route refuses it', () => {
  const system = harness();
  planned(system);
  const plan = plannedPlan(system);
  const working = system.store.listPlanParts(plan.id).find((p) => p.slug === 'catalog');
  assert.ok(working);
  system.store.updatePlanPart(working.id, { status: 'in_review', branch: 'issue/412/catalog', prNumber: 77 });

  const { parts, atoms } = held(system);
  const refusal = regroupRefusal(plannedPlan(system), parts, atoms);
  assert.match(refusal ?? '', /work in flight on "catalog" \(in_review, PR #77\)/);

  const refused = regroupedDocument({
    plan: plannedPlan(system),
    parts,
    atoms,
    groups: [
      { slug: 'catalog', atoms: [] },
      { slug: 'validate', atoms: ATOMS.map((a) => a.slug) },
    ],
  });
  assert.equal(refused.ok, false);

  const drawn = sheet({ parts: parts.map(asView), atoms, status: 'awaiting_approval' });
  assert.ok(!drawn.includes('>Regroup<'), 'a plan with work in flight must not offer a regroup');

  system.store.close();
});

test('an active plan is not regrouped in place — the refusal names the route that does apply', () => {
  const system = harness();
  planned(system);
  const plan = plannedPlan(system);
  system.store.setPlanStatus(plan.id, 'active');
  const { parts, atoms } = held(system);
  const refusal = regroupRefusal(plannedPlan(system), parts, atoms) ?? '';
  assert.match(refusal, /"active"/);
  assert.match(refusal, /amendment/);

  system.store.close();
});

test('the surface says what a grouping costs, and never counts atoms as a refusal', () => {
  const groups = initialGrouping(
    [
      { slug: 'catalog', title: 'The catalog', scope: 'x', atoms: ['catalog-module', 'move-schemas'] },
      { slug: 'validate', title: 'Validation', scope: 'y', atoms: ['validate-at-the-door'] },
    ] as unknown as PlanPartView[],
    ATOMS as unknown as PlanAtom[],
  );
  const cost = groupingCost(groups).join(' ');
  assert.match(cost, /2 parts/);
  assert.match(cost, /2 review rounds and 2 merges/);
  assert.match(cost, /one atom on its own/, 'a part with one atom is one more review round and one more merge');
  assert.match(cost, /often it is not/, 'stated as a cost, never as a refusal');

  const moved = moveAtom(groups, 'move-schemas', 'validate');
  assert.deepEqual(moved.find((g) => g.slug === 'catalog')?.atoms, ['catalog-module']);
  assert.deepEqual(moved.find((g) => g.slug === 'validate')?.atoms, ['validate-at-the-door', 'move-schemas']);
  assert.match(groupingCost(moved).join(' '), /one atom on its own/);
});

function asView(part: PlanPart): PlanPartView {
  return { ...part, depth: 0, acceptanceCriteria: [], outsideScope: [] } as unknown as PlanPartView;
}

function sheet(input: { parts: PlanPartView[]; atoms: PlanAtom[]; status: string }): string {
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
          id: 'plan-412',
          originRef: ORIGIN,
          title: 'Validate every payload',
          status: input.status,
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
        parts: input.parts,
        atoms: input.atoms,
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
        regrouping: false,
        onRegroupView: () => undefined,
        onRegroup: () => undefined,
        canClosePr: false,
        profiles: [],
        defaultProfile: null,
        desktopFolder: '/home/you/shop',
      } as unknown as Parameters<typeof PlanModal>[0]),
    ),
  );
}

function harness(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-regroup-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager() },
  );
}
