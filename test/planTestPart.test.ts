import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { PLAN_COLUMNS } from '../src/store/plans.js';
import { parsePlanDocument, planPartInputs } from '../src/plans/planDocument.js';
import { PLAN_DOCUMENT_SHAPE } from '../src/mcp/planDocumentSchema.js';
import { partDeclarationNote, partsToRetire, planProgress } from '../src/plans/parts.js';
import { DEFAULT_PLANNING, testPartNote } from '../src/plans/planning.js';
import { PromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Issue, Plan, PlanPart, WorldSnapshot } from '../src/types.js';
import { spentAppraisalAttempts } from './support/plans.js';

const NO_BROWSER: EnvironmentConfig[] = [{ name: 'acceptance', at: 'echo sha' }];

const WITH_BROWSER: EnvironmentConfig[] = [
  { name: 'acceptance', at: 'echo sha' },
  {
    name: 'production',
    at: 'echo sha',
    validate: {
      permits: ['check'],
      browser: { runner: 'npx playwright test', listSelectors: 'npx playwright test --list' },
    },
  },
];

function document(coverage: string | null): string {
  return JSON.stringify({
    version: 1,
    reason: 'Two parts: the change, then the coverage it invalidates.',
    parts: [
      { slug: 'checkout', title: 'The confirmation step', scope: 'src/checkout/' },
      {
        slug: 'checkout-coverage',
        title: 'Amend the checkout coverage',
        scope: 'e2e/',
        dependsOn: ['checkout'],
        ...(coverage === null ? {} : { coverage }),
      },
    ],
  });
}

// ---------------------------------------------------------------- the field

test('coverage reaches the row through both transports, and comes back on the part', () => {
  const parsed = parsePlanDocument(document('checkout with a saved card'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.document.parts[1]!.coverage, 'checkout with a saved card');

  const tool = PLAN_DOCUMENT_SHAPE.parts.safeParse(JSON.parse(document('checkout with a saved card')).parts);
  assert.equal(tool.success, true, 'the tool path declares the field too, or zod strips it before the schema sees it');
  assert.equal(tool.success && tool.data[1]!.coverage, 'checkout with a saved card');

  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({ originRef: 'issue:12', title: 'Checkout', status: 'active', reason: 'r' });
  store.plans.upsertPlanParts(plan.id, planPartInputs(parsed.document));
  const parts = store.plans.listPlanParts(plan.id);
  assert.equal(parts[0]!.coverage, null, 'a part that declared none carries null, not an empty string');
  assert.equal(parts[1]!.coverage, 'checkout with a saved card');
  store.close();
});

test('a part with no coverage declared parses, so an older planner is unaffected', () => {
  const parsed = parsePlanDocument(document(null));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.document.parts[1]!.coverage, undefined);
});

test('the agent building a coverage part is shown the area it was asked to cover', () => {
  const note = partDeclarationNote(part('checkout-coverage', { coverage: 'checkout with a saved card' }));
  assert.match(note, /checkout with a saved card/);
  assert.match(note, /allow-list/, 'and told not to bring an inherited critical tag with it');
  assert.equal(partDeclarationNote(part('bare')), '', 'a part declaring nothing still gets no note');
});

// ------------------------------------------------------------ the migration

function beforeTheColumn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-coverage-'));
  const path = join(dir, 'old.db');
  const db = new Database(path);
  const stripped = SCHEMA.split('\n')
    .filter((line) => !/^\s*coverage\s+TEXT/.test(line))
    .join('\n');
  assert.ok(!/\n\s*coverage\s+TEXT/.test(stripped), 'the fixture really is a database from before the column');
  db.exec(stripped);
  db.prepare(
    `INSERT INTO plans (id, origin_ref, title, status, discussing, created_at, updated_at)
     VALUES ('plan_old', 'issue:12', 'Checkout', 'active', 0, ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, depends_on, status, created_at, updated_at)
     VALUES ('plan_old:checkout', 'plan_old', 'checkout', 1, 'The confirmation step', 'src/', '[]', 'merged', ?, ?)`,
  ).run(NOW, NOW);
  db.close();
  return path;
}

const NOW = '2026-09-09T09:00:00.000Z';

test('plan_parts.coverage is declared in PLAN_COLUMNS, so a database from before it gains it on boot', () => {
  assert.equal(PLAN_COLUMNS.plan_parts!.coverage, 'TEXT', 'CREATE TABLE IF NOT EXISTS never alters an existing table');
  const path = beforeTheColumn();
  const store = new Store(path);
  const parts = store.plans.listPlanParts('plan_old');
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.coverage, null, 'null means "not a test part", which is true of every row written before');
  assert.equal(parts[0]!.status, 'merged', 'and nothing else about the row moved');
  store.close();
  const inspect = new Database(path);
  const names = (inspect.prepare(`PRAGMA table_info(plan_parts)`).all() as { name: string }[]).map((c) => c.name);
  inspect.close();
  assert.ok(names.includes('coverage'));
});

test('no backfill runs over the new column, and no runOnce id is introduced', () => {
  const path = beforeTheColumn();
  new Store(path).close();
  const inspect = new Database(path);
  const rows = inspect.prepare(`SELECT slug, coverage, updated_at FROM plan_parts`).all() as {
    slug: string;
    coverage: string | null;
    updated_at: string;
  }[];
  inspect.close();
  assert.deepEqual(rows, [{ slug: 'checkout', coverage: null, updated_at: NOW }], 'no row was rewritten');
  const source = readFileSync('src/store/store.ts', 'utf8');
  const join = source.slice(
    source.indexOf('`validation_checks.area` recomputed'),
    source.indexOf('export class Store'),
  );
  assert.equal(
    (source.match(/\bcoverage\b/g) ?? []).length,
    (join.match(/\bcoverage\b/g) ?? []).length,
    'every mention in the boot sequence is inside the area join — nothing is gated on the column being added',
  );
  assert.ok(!/UPDATE plan_parts/.test(source), 'and the join reads coverage rather than rewriting a part with it');
  assert.ok(!/runOnce/.test(source), 'and no one-shot id came back with it');
});

// ------------------------------------------------------------------ the hold

test('a declared test part holds the goal exactly as any other part does', () => {
  const store = new Store(':memory:');
  const parsed = parsePlanDocument(document('checkout with a saved card'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const plan = store.plans.upsertPlan({ originRef: 'issue:12', title: 'Checkout', status: 'active', reason: 'r' });
  store.plans.upsertPlanParts(plan.id, planPartInputs(parsed.document));
  const [change, coverage] = store.plans.listPlanParts(plan.id);

  store.plans.updatePlanPart(change!.id, { status: 'merged' });
  assert.equal(
    store.plans.rollUpPlanStatus(plan.id),
    null,
    'the plan does not roll up while the coverage part is unbuilt',
  );
  assert.equal(store.plans.getPlanByOrigin('issue:12')?.status, 'active');
  assert.deepEqual(
    planProgress(store.plans.listPlanParts(plan.id)),
    { settled: 1, total: 2 },
    'it is counted like any other part, not exempted from the roll-up',
  );

  store.plans.updatePlanPart(coverage!.id, { status: 'merged' });
  assert.equal(
    store.plans.rollUpPlanStatus(plan.id)?.status,
    'complete',
    'and it completes once the coverage part merges',
  );
  store.close();
});

test('nothing in src/plans/ or src/dispatcher/ reads coverage to decide settlement', () => {
  const mentions = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...mentions(path));
      else if (entry.name.endsWith('.ts') && /\.coverage\b/.test(readFileSync(path, 'utf8'))) found.push(path);
    }
    return found;
  };
  assert.deepEqual(
    [...mentions('src/plans'), ...mentions('src/dispatcher')].sort(),
    ['src/plans/parts.ts', 'src/plans/planDocument.ts'].sort(),
    'a soft hold, a special case in partSettled/liveParts, or an exemption in the roll-up would show up here',
  );
  // planIngest read it once, to hand a check the area it inherited. That join is gone: an area comes
  // from a `suite` step and from nothing else, so a `covers` entry decides nothing about what runs.
  // → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
  assert.doesNotMatch(readFileSync('src/plans/planIngest.ts', 'utf8'), /\.coverage\b/);
  const parts = readFileSync('src/plans/parts.ts', 'utf8');
  const note = parts.slice(parts.indexOf('export function partDeclarationNote'));
  const declaration = note.slice(0, note.indexOf('\nfunction atomCommitNote'));
  assert.equal(
    (parts.match(/\bcoverage\b/g) ?? []).length,
    (declaration.match(/\bcoverage\b/g) ?? []).length,
    'every mention in parts.ts is inside partDeclarationNote — the settlement functions never read it',
  );
});

// ------------------------------------------------------------------ the note

test('the note states the bar, the allow-list and the inherited tag, each by name', () => {
  const note = testPartNote(WITH_BROWSER);
  assert.match(note, /silent and consequential/);
  assert.match(note, /allow-list, never a deny-list/);
  assert.match(note, /inherits that neighbour’s tags/);
  assert.match(note, /Most goals get none/);
  assert.match(note, /nothing rewards a longer/);
  assert.match(note, /`coverage`/, 'and names the field the planner is to declare');
});

test('the note says what is not an area, so the nearest one is not picked for a look-at-it check', () => {
  const note = testPartNote(WITH_BROWSER);
  assert.match(note, /is not an area/, 'the shape of check that cannot honestly have one is named');
  assert.match(note, /snapshot suite/, 'and where it goes instead');
  assert.match(
    note,
    /green row that verified something the check does not talk about/,
    'and why the nearest area is worse than no test part at all',
  );
});

function issue(number: number): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Do the thing.',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
  };
}

function world(issues: Issue[]): WorldSnapshot {
  return { takenAt: '2026-09-09T12:00:00.000Z', pullRequests: [], issues };
}

function planRow(status: Plan['status']): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Checkout',
    status,
    reason: null,
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
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
}

function part(slug: string, overrides: Partial<PlanPart> = {}): PlanPart {
  return {
    id: `plan_1:${slug}`,
    planId: 'plan_1',
    slug,
    seq: 1,
    title: `The ${slug} part`,
    scope: `src/${slug}/`,
    touches: [],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    coverage: null,
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
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

async function plannerPrompt(
  environments: EnvironmentConfig[],
  which: 'plan' | 'replan',
  templates?: PromptTemplates,
): Promise<string> {
  const replan = which === 'replan';
  const context: DispatchContext = {
    world: world([issue(12)]),
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    plans: replan ? [planRow('planning')] : [],
    recentDecisions: spentAppraisalAttempts(12),
  };
  const dispatcher = new RuleDispatcher(
    {},
    {},
    templates,
    'main',
    DEFAULT_PLANNING,
    {},
    {},
    '.lubbdubb/validation',
    '#',
    {},
    { routing: null, modes: {} },
    '',
    '',
    undefined,
    (offerings) => testPartNote(environments, offerings),
  );
  const { actions } = await dispatcher.decide(context);
  const action = actions.find((a) => a.rule === 'issue-plan');
  assert.ok(action && action.type === 'dispatch_code_agent', `no ${which} was dispatched`);
  assert.match(action.title, replan ? /^Replan/ : /^Plan/, 'the arm under test is the one that was rendered');
  return action.prompt;
}

test('both planning prompts carry the note where an environment declares a browser suite', async () => {
  const note = testPartNote(WITH_BROWSER);
  assert.notEqual(note, '');
  for (const which of ['plan', 'replan'] as const) {
    const prompt = await plannerPrompt(WITH_BROWSER, which);
    assert.ok(prompt.includes(note), `the ${which} prompt carries the note in full`);
    assert.ok(prompt.endsWith(note), 'appended, so it survives whatever the template above it says');
  }
});

test('neither planning prompt carries it where no environment declares one', async () => {
  assert.equal(testPartNote(NO_BROWSER), '', 'a planner is never told to declare a part nobody can build');
  assert.equal(testPartNote([]), '');
  for (const which of ['plan', 'replan'] as const) {
    const prompt = await plannerPrompt(NO_BROWSER, which);
    assert.ok(!/allow-list, never a deny-list/.test(prompt), `the ${which} prompt does not mention the bar`);
    assert.ok(!/silent and consequential/.test(prompt));
    assert.ok(!/`coverage`/.test(prompt));
  }
});

test('an override that never learned any new token still receives the note in full', async () => {
  const overridden = new PromptTemplates({
    'issue-plan': 'Plan it. Nothing here but this sentence.',
    'issue-replan': 'Plan it again. Nothing here but this sentence.',
  });
  const note = testPartNote(WITH_BROWSER);
  for (const which of ['plan', 'replan'] as const) {
    const prompt = await plannerPrompt(WITH_BROWSER, which, overridden);
    assert.match(prompt, /Nothing here but this sentence/, 'the override really is what was rendered');
    assert.ok(prompt.includes(note), 'and the note is concatenated after it rather than interpolated into it');
    assert.ok(!/\{[a-zA-Z]+\}/.test(note), 'the note is a rendered string, so no template declares a token for it');
  }
});

// ---------------------------------------------------------------- the replan

test('a replan declares a new part to amend a merged one, and never retracts it', () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({ originRef: 'issue:12', title: 'Checkout', status: 'active', reason: 'r' });
  const declared = (slugs: { slug: string; coverage?: string }[]) =>
    store.plans.upsertPlanParts(
      plan.id,
      slugs.map((s, i) => ({
        slug: s.slug,
        seq: i + 1,
        title: `The ${s.slug} part`,
        scope: 'e2e/',
        touches: [],
        dependsOn: [],
        rationale: null,
        acceptance: null,
        size: null,
        expectedKind: null,
        profile: null,
        coverage: s.coverage ?? null,
      })),
    );
  declared([{ slug: 'checkout-coverage', coverage: 'checkout with a saved card' }]);
  const merged = store.plans.listPlanParts(plan.id)[0]!;
  store.plans.updatePlanPart(merged.id, { status: 'merged', prNumber: 41 });

  assert.deepEqual(
    partsToRetire(store.plans.listPlanParts(plan.id), ['something-else']),
    [],
    'a merged part is work, so a replan that stops declaring it leaves it alone',
  );

  declared([
    { slug: 'checkout-coverage', coverage: 'checkout with a saved card' },
    { slug: 'checkout-coverage-express', coverage: 'checkout with express pay' },
  ]);
  const after = store.plans.listPlanParts(plan.id);
  assert.equal(after.find((p) => p.slug === 'checkout-coverage')?.status, 'merged', 'the merged part is untouched');
  assert.equal(after.find((p) => p.slug === 'checkout-coverage')?.prNumber, 41);
  const fresh = after.find((p) => p.slug === 'checkout-coverage-express');
  assert.equal(fresh?.status, 'pending', 'and the amendment is a new slug, scheduled as a fresh part');
  assert.equal(fresh?.coverage, 'checkout with express pay');

  declared([{ slug: 'checkout-coverage', coverage: 'checkout with a saved card and a coupon' }]);
  const rewritten = store.plans.listPlanParts(plan.id).find((p) => p.slug === 'checkout-coverage')!;
  assert.equal(rewritten.coverage, 'checkout with a saved card and a coupon', 'the declaration is refreshed');
  assert.equal(
    rewritten.status,
    'merged',
    'but nothing re-dispatches it — an amendment written that way is never built',
  );
  store.close();
});

// ------------------------------------------------------- striking one at the gate

test('striking a test part is the existing gate — no route, body field or control is added for it', () => {
  const approval = readFileSync('src/server/routes/plans.ts', 'utf8');
  assert.ok(!/coverage/.test(approval), 'the approval body gains no coverage-specific field');
  const gate = readFileSync('src/plans/planApproval.ts', 'utf8');
  assert.ok(!/coverage/.test(gate), 'Reject, then the replan that follows, is the whole of the pressure valve');
});
