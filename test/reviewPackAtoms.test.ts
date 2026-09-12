import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadConfig } from '../src/config/config.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { atomList, atomsForPr } from '../src/reviewPacks/atoms.js';
import { renderReviewPackCompanion } from '../src/reviewPacks/companion.js';
import { ideaAtom } from '../src/reviewPacks/derive.js';
import { PLUMBING_IDEA_ID } from '../src/reviewPacks/hunks.js';
import { parseDiffHunks } from '../src/reviewPacks/hunks.js';
import { packOrigin } from '../src/reviewPacks/origins.js';
import { assemblePack, type Commission } from '../src/reviewPacks/submission.js';
import { buildApp } from '../src/server/app.js';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import { buildSystem } from '../src/system.js';
import type { PlanAtom, PlanPart, ReviewIdea, ReviewPack } from '../src/types.js';
import type { ReviewPackPayload } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { findTask } from './support/tasks.js';

(globalThis as { React?: typeof React }).React = React;

const { ReviewPackPage } = await import('../web/src/components/ReviewPackPage.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { ideaAtom: webIdeaAtom } = await import('../web/src/view/reviewPack.js');
const { demoApi } = await import('../web/src/demo/demoBackend.js');

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' export { a };',
].join('\n');

const CATALOG = {
  slug: 'catalog-module',
  title: 'A catalog module that names every job type',
  intent: 'One place a payload schema can be looked up from.',
  touches: ['packages/jobs/src/catalog.ts'],
  acceptance: 'An unknown job type throws by name.',
  dependsOn: [] as string[],
  rejected: [{ route: 'Export a lookup map from each module.', because: 'The map and the modules can disagree.' }],
};

const MOVE = {
  slug: 'move-schemas',
  title: 'Move the existing schemas into the catalog',
  intent: 'Behaviour-free: everything still imports them from where it did.',
  touches: ['packages/jobs/src/schemas/'],
  acceptance: 'Nothing imports a schema from its old home.',
  dependsOn: ['catalog-module'],
  rejected: [] as { route: string; because: string }[],
};

const PLAN_DOCUMENT = JSON.stringify({
  version: 1,
  reason: 'The catalog has to exist before anything can read it.',
  atoms: [CATALOG, MOVE],
  parts: [{ slug: 'catalog', title: 'The catalog', scope: 'packages/jobs', atoms: ['catalog-module', 'move-schemas'] }],
});

// ── the lookup ──────────────────────────────────────────────────────────────

function part(over: Partial<PlanPart>): PlanPart {
  return {
    id: 'plan-1:catalog',
    planId: 'plan-1',
    slug: 'catalog',
    seq: 1,
    title: 'The catalog',
    scope: 'packages/jobs',
    touches: [],
    atoms: ['catalog-module', 'move-schemas'],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: 7,
    status: 'in_review',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...over,
  };
}

const atomRow = (planId: string, seq: number, seed: typeof CATALOG): PlanAtom => ({
  id: `${planId}:${seed.slug}`,
  planId,
  seq,
  slug: seed.slug,
  title: seed.title,
  intent: seed.intent,
  touches: seed.touches,
  acceptance: seed.acceptance ?? null,
  dependsOn: seed.dependsOn,
  rejected: seed.rejected,
});

test('the atoms behind a pull request are the ones its part carries, and every other PR has none', () => {
  const atoms = [
    atomRow('plan-1', 1, CATALOG),
    atomRow('plan-1', 2, MOVE),
    atomRow('plan-2', 1, { ...MOVE, slug: 'elsewhere' }),
  ];
  const parts = [
    part({}),
    part({ id: 'plan-2:other', planId: 'plan-2', slug: 'other', prNumber: 9, atoms: ['elsewhere'] }),
  ];

  assert.deepEqual(
    atomsForPr(7, parts, atoms).map((a) => a.slug),
    ['catalog-module', 'move-schemas'],
    'the part that owns the pull request hands over its atoms, in the order it carries them',
  );
  assert.deepEqual(
    atomsForPr(9, parts, atoms).map((a) => a.slug),
    ['elsewhere'],
    'the atoms are filtered to the part’s own plan',
  );
  assert.deepEqual(atomsForPr(11, parts, atoms), [], 'a pull request with no part behind it has no atoms');
  assert.deepEqual(atomsForPr(7, [], atoms), [], 'and neither has one on a harness with no plans at all');
  assert.deepEqual(atomsForPr(7, [part({ atoms: undefined })], atoms), [], 'a part from before atoms carries none');
  assert.deepEqual(
    atomsForPr(7, [part({ atoms: ['ghost'] })], atoms),
    [],
    'a slug with no atom row behind it is dropped rather than half-declared',
  );
});

// ── what the author is told ─────────────────────────────────────────────────

test('the author’s atoms section is appended, names every atom, and carries no placeholder', () => {
  const section = atomList([atomRow('plan-1', 1, CATALOG), atomRow('plan-1', 2, MOVE)]);
  assert.match(section, /## The atoms this pull request was planned as/);
  for (const slug of ['catalog-module', 'move-schemas']) assert.ok(section.includes(slug), `names ${slug}`);
  assert.ok(section.includes(CATALOG.intent), 'each atom’s intent reaches the author');
  assert.ok(section.includes(CATALOG.acceptance), 'and its acceptance');
  assert.ok(section.includes(CATALOG.rejected[0]!.route), 'a plan-time rejection reaches the author');
  assert.match(section, /never a claim/, 'told plainly that a rejection is provenance and not a claim');
  assert.match(section, /`atom: null`/, 'told plainly that null is the right answer where no atom fits');
  assert.doesNotMatch(section, /\{[a-zA-Z]+\}/, 'the section is appended text and never an interpolated template');
  assert.equal(atomList([]), '', 'a pull request with no atoms behind it appends nothing');
});

test('a pack for a pull request with no atoms behind it is prompted byte-for-byte as it was', async () => {
  const withAtoms = await packPrompt(true);
  const without = await packPrompt(false);
  const section = atomList([atomRow('plan', 1, CATALOG), atomRow('plan', 2, MOVE)]);
  assert.ok(withAtoms.includes('## The atoms this pull request was planned as'), 'the section is there when atoms are');
  assert.ok(!without.includes('## The atoms'), 'and gone when they are not');
  assert.equal(
    withAtoms.replace(`\n\n${section}`, ''),
    without,
    'the two prompts differ by the appended section and by nothing else',
  );
});

async function packPrompt(withAtoms: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pack-atoms-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver().setDiff('main', HEAD, DIFF),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
    },
  );
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add the catalog', branch: 'feature-7', headSha: HEAD });
  await system.harness.runCycle('manual');

  if (withAtoms) {
    const parsed = parsePlanDocument(PLAN_DOCUMENT);
    assert.equal(parsed.ok, true);
    const ingested = ingestPlanDocument(system.store, {
      doc: parsed.ok ? parsed.document : (undefined as never),
      originRef: 'issue:390',
      title: 'Issue 390',
    });
    const stored = system.store.plans.listPlanParts(ingested.plan.id);
    assert.equal(stored.length, 1);
    system.store.plans.updatePlanPart(stored[0]!.id, { prNumber: 7, status: 'in_review' });
  }

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202, res.body);
  await app.close();
  await system.reviewPacks.whenIdle();
  const task = findTask(system.store, (t) => t.originRef === packOrigin(7));
  assert.ok(task, 'the author task exists');
  const prompt = task!.prompt;
  system.store.close();
  return prompt;
}

// ── what the submit tool takes, and what it refuses ─────────────────────────

function commission(atoms: readonly string[]): Commission {
  return {
    prNumber: 7,
    headSha: HEAD,
    hunks: parseDiffHunks(DIFF),
    atoms,
    entries: [],
    readRegion: () => ['a line'],
  };
}

function submission(ideas: unknown[]): Record<string, unknown> {
  return { headline: 'It does a thing.', summary: '- It does **a thing**.', estimatedMinutes: 3, ideas };
}

const oneIdea = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  claim: 'The module gains a second constant.',
  title: 'One new constant',
  anchors: [{ kind: 'hunk', hunk: 'h1', gist: 'The constant lands here.' }],
  ...over,
});

test('an idea carries the atom it names', () => {
  const built = assemblePack(
    commission(['catalog-module', 'move-schemas']),
    submission([oneIdea({ atom: 'catalog-module' })]),
  );
  assert.equal(built.ok, true, built.ok ? '' : built.error);
  assert.equal(built.ok ? built.pack.ideas[0]!.atom : null, 'catalog-module');
});

test('an idea the atoms do not cover submits without complaint — it is a finding, not an error', () => {
  const built = assemblePack(commission(['catalog-module']), submission([oneIdea()]));
  assert.equal(built.ok, true, built.ok ? '' : built.error);
  assert.equal(built.ok ? built.pack.ideas[0]!.atom : 'set', null);

  const explicit = assemblePack(commission(['catalog-module']), submission([oneIdea({ atom: null })]));
  assert.equal(explicit.ok, true, explicit.ok ? '' : explicit.error);
  assert.equal(explicit.ok ? explicit.pack.ideas[0]!.atom : 'set', null);
});

test('an atom naming a slug the part does not carry is refused, naming the slugs it could have used', () => {
  const built = assemblePack(
    commission(['catalog-module', 'move-schemas']),
    submission([oneIdea({ atom: 'catlog-module' })]),
  );
  assert.equal(built.ok, false);
  const error = built.ok ? '' : built.error;
  assert.match(error, /catlog-module/, 'the refusal quotes what was written');
  assert.match(error, /catalog-module, move-schemas/, 'and names every slug it could have used');

  const none = assemblePack(commission([]), submission([oneIdea({ atom: 'catalog-module' })]));
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.error, /no atoms were declared/);
});

// ── both renderings ─────────────────────────────────────────────────────────

function idea(over: Partial<ReviewIdea> & { id: string }): ReviewIdea {
  return {
    claim: 'The module gains a second constant.',
    title: `Title of ${over.id}`,
    atom: null,
    cue: null,
    anchors: [
      {
        kind: 'hunk',
        range: { path: 'src/a.ts', start: 1, end: 3 },
        code: [' const a = 1;', '+const b = 2;'],
        gist: 'The constant lands here.',
        note: null,
        caption: null,
        mark: null,
      },
    ],
    claims: [],
    attention: null,
    ...over,
  };
}

function pack(ideas: ReviewIdea[]): ReviewPack {
  return {
    schema: REVIEW_PACK_SCHEMA,
    prNumber: 7,
    headSha: HEAD,
    headline: 'The module gains a constant.',
    summary: '- One file changes.',
    estimatedMinutes: 2,
    order: [],
    witnessed: false,
    fake: 'nothing',
    ideas,
  };
}

const noop = async (): Promise<void> => {};

function renderPage(p: ReviewPack): string {
  const payload: ReviewPackPayload = {
    pack: p,
    writtenAt: '2026-09-01T13:10:00Z',
    marks: [],
    head: HEAD,
    stale: null,
    checking: false,
    sharing: { available: true, share: null },
  };
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: {},
      openGoal: () => undefined,
      hasGoal: () => false,
      openPr: () => undefined,
      hasPr: () => false,
      children: createElement(ReviewPackPage, {
        payload,
        marks: [],
        entries: null,
        openIdea: null,
        onOpenIdea: () => undefined,
        onRead: noop,
        onSeen: noop,
        onAttention: noop,
        onAsk: noop,
        onShare: noop,
        onUnshare: noop,
        shareRefusal: null,
        onShareRefused: () => undefined,
        askRefusal: null,
        onAskRefused: () => undefined,
        refUrls: {},
      }),
    }),
  );
}

const renderCompanion = (p: ReviewPack): string =>
  renderReviewPackCompanion({ pack: p, writtenAt: '2026-09-01T13:10:00Z' });

test('an idea with no atom is drawn as the thing worth looking at, on both surfaces', () => {
  const mixed = pack([idea({ id: 'idea_a', atom: 'catalog-module' }), idea({ id: 'idea_b' })]);
  assert.deepEqual(ideaAtom(mixed, mixed.ideas[0]!), { kind: 'declared', slug: 'catalog-module' });
  assert.deepEqual(ideaAtom(mixed, mixed.ideas[1]!), { kind: 'undeclared' });

  for (const html of [renderCompanion(mixed), renderPage(mixed)]) {
    assert.match(html, /catalog-module/, 'the atom an idea names is drawn');
    assert.match(html, /class="rp-atom rp-atom-none"/, 'and the idea no atom covers is drawn as a finding');
    assert.match(html, /the plan did not declare this work/);
  }
});

test('a pack with no atoms behind it draws nothing at all about them', () => {
  const bare = pack([idea({ id: 'idea_a' }), idea({ id: 'idea_b' })]);
  for (const i of bare.ideas) assert.deepEqual(ideaAtom(bare, i), { kind: 'none' });
  for (const html of [renderCompanion(bare), renderPage(bare)]) {
    assert.doesNotMatch(html, /class="rp-atom/, 'no atom row is drawn, so the page is the page it was');
    assert.doesNotMatch(html, /no atom —/);
  }
});

test('`plumbing` never reads as work the plan did not declare', () => {
  const withAtoms = pack([
    idea({ id: 'idea_a', atom: 'catalog-module' }),
    idea({ id: PLUMBING_IDEA_ID }),
    idea({ id: 'idea_c' }),
  ]);
  const [named, plumbing, undeclared] = withAtoms.ideas as [ReviewIdea, ReviewIdea, ReviewIdea];
  assert.deepEqual(ideaAtom(withAtoms, plumbing), { kind: 'none' }, 'a lockfile is not undeclared work');
  assert.deepEqual(ideaAtom(withAtoms, undeclared), { kind: 'undeclared' }, 'an ordinary idea still is');
  assert.deepEqual(ideaAtom(withAtoms, named), { kind: 'declared', slug: 'catalog-module' });
  for (const i of withAtoms.ideas) assert.deepEqual(ideaAtom(withAtoms, i), webIdeaAtom(withAtoms, i));

  for (const html of [renderCompanion(withAtoms), renderPage(withAtoms)]) {
    assert.equal(
      (html.match(/class="rp-atom rp-atom-none"/g) ?? []).length,
      1,
      'the finding is drawn once, on the idea that earned it',
    );
  }
});

test('the demo serves a review pack, and it is the one whose part declares atoms', async () => {
  const reading = await demoApi.getReviewPack(413);
  assert.equal(reading.kind, 'pack', 'PR #413 has a pack a visitor can open');
  if (reading.kind !== 'pack') return;
  const { pack: demoPack, marks } = reading.payload;

  const carried = ['enqueue-validates', 'drop-route-parsers'];
  assert.deepEqual(
    demoPack.ideas.filter((i) => i.atom !== null).map((i) => i.atom),
    carried,
    'every atom an idea names is one the plan part behind #413 carries',
  );
  assert.equal(
    demoPack.ideas.filter((i) => ideaAtom(demoPack, i).kind === 'undeclared').length,
    1,
    'exactly one idea is work the plan did not declare — the finding the demo exists to show',
  );
  assert.equal(
    ideaAtom(demoPack, demoPack.ideas.find((i) => i.id === PLUMBING_IDEA_ID)!).kind,
    'none',
    'and the plumbing idea is not counted as a second one',
  );

  assert.deepEqual(
    [...new Set(demoPack.ideas.map((i) => i.attention))].sort(),
    ['decide', 'read', 'skim', 'split'],
    'every attention label a checker can write is on the one pack the demo has to teach them with',
  );
  assert.deepEqual(
    [...demoPack.order].sort(),
    demoPack.ideas.map((i) => i.id).sort(),
    'the checker ordered every idea, so the page draws numbers that mean something',
  );
  const wrong = demoPack.ideas.flatMap((i) => i.claims).filter((c) => c.verdict === 'false');
  assert.equal(wrong.length, 1, 'one false claim, so the gate draws');
  assert.ok(wrong[0]!.finding?.counter, 'and it carries the finding and the counter-example the gate leads to');
  assert.ok(
    demoPack.ideas.some((i) => i.anchors.some((a) => a.kind === 'region')),
    'a region anchor, so the demo shows a file the diff does not touch',
  );

  assert.equal((await demoApi.getReviewPack(414)).kind, 'none', 'no other pull request has one');
  assert.equal(marks.length, 0, 'nobody has marked it yet');

  const marked = await demoApi.markReviewIdeaRead(413, 'idea_routes', true);
  assert.equal(marked.marks.length, 1, 'a demo interaction commits');
  assert.equal(marked.marks[0]!.read, true);

  const cited = new Set((await demoApi.getScratchpad('pr:413')).entries.map((e) => e.id));
  for (const i of demoPack.ideas) {
    for (const c of i.claims) {
      if (c.provenance.kind === 'inferred') continue;
      assert.ok(cited.has(c.provenance.entryId), `the pad holds ${c.provenance.entryId}, so it renders verbatim`);
    }
  }
});
