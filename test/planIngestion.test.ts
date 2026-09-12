import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_PLAN_DOCUMENT_CHARS,
  PLAN_FILE,
  isPlanFile,
  parsePlanDocument,
  planPartInputs,
  validatePlanDocument,
} from '../src/plans/planDocument.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import type { Agent, PlanPartInput } from '../src/types.js';
import { refusePlan, releasePlan } from '../src/plans/planApproval.js';
import { liveParts } from '../src/plans/parts.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

test('isPlanFile matches only the reserved path, separator-agnostically', () => {
  assert.equal(isPlanFile(PLAN_FILE), true);
  assert.equal(isPlanFile('.lubbdubb\\plan.json'), true);
  assert.equal(isPlanFile('docs/plan.json'), false);
  assert.equal(isPlanFile('sub/.lubbdubb/plan.json'), false);
  assert.equal(isPlanFile('.lubbdubb/plan.jsonc'), false);
});

test('a plan needs at least one part, and one part is an ordinary plan', () => {
  const none = parsePlanDocument('{"version":1,"verdict":"single","reason":"One small fix."}');
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.error, /at least one part/);

  const one = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'One reviewable change.',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/cache.ts' }],
    }),
  );
  assert.equal(one.ok, true, 'one part is a plan, not a special case');
  assert.equal(one.ok && one.document.parts.length, 1);

  const parts = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Schema must land before the reader.',
      parts: [
        { slug: 'schema', title: 'Add the table', scope: 'src/store', dependsOn: [] },
        { slug: 'reader', title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
      ],
    }),
  );
  assert.equal(parts.ok, true);
  assert.deepEqual(parts.ok ? planPartInputs(parts.document) : null, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Add the table',
      scope: 'src/store',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      atoms: [],
      size: null,
      expectedKind: null,
      profile: null,
      coverage: null,
    },
    {
      slug: 'reader',
      seq: 2,
      title: 'Read it',
      scope: 'src/dispatcher',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      touches: [],
      atoms: [],
      size: null,
      expectedKind: null,
      profile: null,
      coverage: null,
    },
  ]);
});

test('parsePlanDocument rejects malformed plans with a reason, never throwing', () => {
  const bad = (raw: string): string => {
    const result = parsePlanDocument(raw);
    assert.equal(result.ok, false, `expected rejection for ${raw}`);
    return result.ok ? '' : result.error;
  };
  assert.match(bad('{'), /not valid JSON/);
  const one = '[{"slug":"a","title":"A","scope":"s"}]';
  assert.match(bad(`{"version":2,"reason":"x","parts":${one}}`), /version/);
  assert.match(bad(`{"version":1,"parts":${one}}`), /reason/);
  assert.match(bad('{"version":1,"reason":"x","parts":[]}'), /at least one part/);
  assert.match(bad('{"version":1,"verdict":"single","reason":"x"}'), /at least one part/);
  const part = (slug: string, dependsOn: string[]): Record<string, unknown> => ({
    slug,
    title: 't',
    scope: 's',
    dependsOn,
  });
  const doc = (parts: unknown[]): string => JSON.stringify({ version: 1, reason: 'x', parts });
  assert.match(bad(doc([part('a', []), part('a', [])])), /duplicate slug "a"/);
  assert.match(bad(doc([part('a', ['a'])])), /depends on itself/);
  assert.match(bad(doc([part('a', ['ghost'])])), /unknown part "ghost"/);
  assert.match(bad(doc([{ slug: 'Not Kebab', title: 't', scope: 's', dependsOn: [] }])), /kebab-case/);
});

test('a plan upserts by issue origin and its parts merge on slug', () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Two PRs.',
  });
  store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
    {
      slug: 'reader',
      seq: 2,
      title: 'Reader',
      scope: 'src/dispatcher',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);

  const parts = store.plans.listPlanParts(plan.id);
  assert.deepEqual(
    parts.map((p) => p.slug),
    ['schema', 'reader'],
  );
  assert.deepEqual(parts[1]?.dependsOn, ['schema']);
  assert.equal(parts[0]?.status, 'pending');

  const replanned = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Three.',
  });
  assert.equal(replanned.id, plan.id, 'the plan id is stable across a replan');
  assert.equal(replanned.createdAt, plan.createdAt);
  store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema (revised)',
      scope: 'src/store',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
    {
      slug: 'extra',
      seq: 2,
      title: 'Extra',
      scope: 'src/server',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);
  const after = store.plans.listPlanParts(plan.id);
  assert.deepEqual(
    after.map((p) => p.slug).sort(),
    ['extra', 'reader', 'schema'],
    'an amended plan merges rather than wiping in-flight parts',
  );
  assert.equal(after.find((p) => p.slug === 'schema')?.title, 'Schema (revised)');

  assert.deepEqual(
    store.plans.listPlans().map((p) => p.originRef),
    ['issue:12'],
  );
  assert.equal(store.plans.getPlanByOrigin('issue:99'), null);
  store.close();
});

test('a re-declared slug is un-retired, so Reject then Replan is not a goal-killer', () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'awaiting_approval',
    reason: 'Two PRs.',
  });
  store.plans.upsertPlanParts(plan.id, [part('schema', 1, 'Schema'), part('reader', 2, 'Reader')]);

  const refused = refusePlan(store, plan.id, 'issue:12', 'the split is wrong');
  assert.equal(refused.ok, true);
  assert.deepEqual(
    store.plans.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
  );

  store.plans.upsertPlanParts(plan.id, [part('schema', 1, 'Schema, revised'), part('reader', 2, 'Reader, revised')]);
  const back = store.plans.listPlanParts(plan.id);
  assert.deepEqual(
    back.map((p) => [p.slug, p.status, p.title]),
    [
      ['schema', 'pending', 'Schema, revised'],
      ['reader', 'pending', 'Reader, revised'],
    ],
  );
  assert.equal(liveParts(back).length, 2);
  store.close();
});

test('a dropped part re-declared by a later amendment comes back, reason and all', () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({ originRef: 'issue:13', title: 'Thing', status: 'active', reason: null });
  store.plans.upsertPlanParts(plan.id, [part('a', 1, 'A'), part('b', 2, 'B')]);
  store.plans.updatePlanPart(`${plan.id}:b`, { status: 'blocked', blockedReason: 'a branch is in the way' });
  store.plans.updatePlanPart(`${plan.id}:b`, { status: 'retired' });
  store.plans.upsertPlanParts(plan.id, [part('a', 1, 'A')]);
  assert.equal(store.plans.listPlanParts(plan.id).find((p) => p.slug === 'b')?.status, 'retired');

  store.plans.upsertPlanParts(plan.id, [part('a', 1, 'A'), part('b', 2, 'B, back again')]);
  const b = store.plans.listPlanParts(plan.id).find((p) => p.slug === 'b');
  assert.equal(b?.status, 'pending');
  assert.equal(b?.title, 'B, back again');
  assert.equal(b?.blockedReason, null);
  store.close();
});

test("progress survives an amendment — only retirement is the declaration's to lift", () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({ originRef: 'issue:14', title: 'Thing', status: 'active', reason: null });
  store.plans.upsertPlanParts(plan.id, [part('a', 1, 'A')]);
  store.plans.updatePlanPart(`${plan.id}:a`, { status: 'blocked', blockedReason: 'CI is red', branch: 'issue/14/a' });

  store.plans.upsertPlanParts(plan.id, [part('a', 1, 'A, reworded')]);
  const a = store.plans.listPlanParts(plan.id)[0];
  assert.equal(a?.status, 'blocked');
  assert.equal(a?.blockedReason, 'CI is red');
  assert.equal(a?.branch, 'issue/14/a');
  assert.equal(a?.title, 'A, reworded');
  store.close();
});

test('a plan with no live parts is refused rather than released into silence', () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({
    originRef: 'issue:15',
    title: 'Thing',
    status: 'awaiting_approval',
    reason: null,
  });
  store.plans.upsertPlanParts(plan.id, [part('a', 1, 'A')]);
  store.plans.updatePlanPart(`${plan.id}:a`, { status: 'retired' });
  const released = releasePlan(store, plan.id, 'issue:15');
  assert.equal(released.ok, false);
  assert.match(released.detail, /no live parts/);
  assert.equal(store.plans.getPlan(plan.id)?.status, 'awaiting_approval');
  store.close();
});

function part(slug: string, seq: number, title: string): PlanPartInput {
  return {
    slug,
    seq,
    title,
    scope: 'src',
    dependsOn: [],
    rationale: null,
    acceptance: null,
    touches: [],
    size: null,
    expectedKind: null,
  };
}

function planningConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-plan-'));
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

function plannerAgent(system: System, originRef: string): Agent {
  const cwd = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Plan issue #12',
    prompt: 'plan it',
    branch: 'plan/issue/12',
    originRef,
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, cwd);
}

function writeThroughHook(system: System, agent: Agent, relPath: string, body: string): void {
  const target = join(agent.cwd, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  const spool = system.agents.fileEventsDir(agent.id);
  assert.ok(spool, 'the spawned agent has a spool dir');
  writeFileSync(join(spool!, `1-a.json`), JSON.stringify({ path: target, tool: 'Write' }));
  system.agents.drainFileEvents(agent.id);
}

test('a planner writing plan.json persists the plan at drain time, one part or many', () => {
  const system = buildSystem(planningConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  const a = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(
    system,
    a,
    PLAN_FILE,
    JSON.stringify({
      version: 1,
      reason: 'Schema first.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'reader', title: 'Reader', scope: 'src/dispatcher', dependsOn: ['schema'] },
      ],
    }),
  );
  const plan = system.store.plans.getPlanByOrigin('issue:12');
  assert.ok(plan, 'the plan was ingested from the worktree');
  assert.equal(plan!.status, 'awaiting_approval');
  assert.equal(plan!.reason, 'Schema first.');
  assert.equal(plan!.title, 'Big thing', 'the issue title, not the task title');
  assert.deepEqual(
    system.store.plans.listPlanParts(plan!.id).map((p) => p.slug),
    ['schema', 'reader'],
  );

  const b = plannerAgent(system, 'issue:13:plan');
  writeThroughHook(
    system,
    b,
    PLAN_FILE,
    JSON.stringify({
      version: 1,
      reason: 'One PR is plenty.',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    }),
  );
  const one = system.store.plans.getPlanByOrigin('issue:13')!;
  assert.equal(one.status, 'awaiting_approval', 'one part or eight, a plan is asked about on the same terms');
  assert.deepEqual(
    system.store.plans.listPlanParts(one.id).map((p) => p.slug),
    ['whole'],
  );

  system.store.close();
});

test('an invalid or non-planner plan.json records no plan (and an invalid one is surfaced)', () => {
  const errors: string[] = [];
  const system = buildSystem(planningConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  system.errors.on('logged', (e) => errors.push(e.message));

  const bad = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(system, bad, PLAN_FILE, '{"version":1,"verdict":"parts","reason":"x","parts":[]}');
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null);
  assert.equal(errors.filter((m) => m.includes('invalid')).length, 1);

  const pickup = plannerAgent(system, 'issue:14');
  writeThroughHook(
    system,
    pickup,
    PLAN_FILE,
    '{"version":1,"verdict":"parts","reason":"x","parts":[{"slug":"a","title":"A","scope":"s","dependsOn":[]}]}',
  );
  assert.equal(system.store.plans.getPlanByOrigin('issue:14'), null);

  system.store.close();
});

test('the plan file is tracked as a written file but never promoted to an artifact chip', () => {
  const system = buildSystem(planningConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const agent = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(
    system,
    agent,
    PLAN_FILE,
    '{"version":1,"reason":"One PR.","parts":[{"slug":"whole","title":"A","scope":"s"}]}',
  );

  assert.deepEqual(
    system.store.agents.listFiles(agent.id).map((f) => f.path),
    [PLAN_FILE],
  );
  assert.deepEqual(system.store.agents.listFlags(agent.id), [], 'a side-channel file is not an artifact');
  system.store.close();
});

test('a part may declare several dependencies, and the graph must still be acyclic', () => {
  const doc = (parts: string): string => `{"version":1,"verdict":"parts","reason":"x","parts":[${parts}]}`;
  const part = (slug: string, deps: string[]): string =>
    `{"slug":"${slug}","title":"T","scope":"s","dependsOn":[${deps.map((d) => `"${d}"`).join(',')}]}`;

  const rejoin = parsePlanDocument(doc([part('a', []), part('b', []), part('c', ['a', 'b'])].join(',')));
  assert.equal(rejoin.ok, true);
  assert.deepEqual(rejoin.ok ? rejoin.document.parts[2]?.dependsOn : null, ['a', 'b']);

  const cycle = parsePlanDocument(doc([part('a', ['b']), part('b', ['a'])].join(',')));
  assert.equal(cycle.ok, false);
  assert.match(cycle.ok === false ? cycle.error : '', /dependency cycle/);

  const deep = parsePlanDocument(doc([part('x', []), part('a', ['x', 'b']), part('b', ['a'])].join(',')));
  assert.equal(deep.ok, false);
  assert.match(deep.ok === false ? deep.error : '', /dependency cycle/);

  const bad = parsePlanDocument(doc([part('a', []), part('b', ['a', 'nope'])].join(',')));
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.error : '', /unknown part "nope"/);

  assert.equal(parsePlanDocument(doc([part('a', []), part('b', ['a']), part('c', ['b'])].join(','))).ok, true);
  assert.equal(
    parsePlanDocument(
      doc([part('root', []), part('l', ['root']), part('r', ['root']), part('join', ['l', 'r'])].join(',')),
    ).ok,
    true,
  );
});

test('the widened plan document round-trips through ingestion', () => {
  const store = new Store(':memory:');
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'the signer must exist before the route verifies one',
      diagnosis: 'the route sits inside the prefix guard, and a navigation cannot carry the header',
      approach: 'move it out and gate it on a signed capability minted into the snapshot',
      risks: 'part 2 briefly serves artifacts with no guard',
      outOfScope: 'capability revocation',
      document: '# Why\n\nBecause the guard is a prefix, not a per-route opt-in.',
      parts: [
        {
          slug: 'signer',
          title: 'Add the signer',
          scope: 'src/server/artifactCapability.ts',
          dependsOn: [],
          rationale: 'a pure predicate with no callers',
          acceptance: 'mint/verify round-trip, tampered and expired both refused',
          touches: [],
        },
      ],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const { plan } = ingestPlanDocument(store, {
    doc: parsed.document,
    originRef: 'issue:231',
    title: 'Serve artifacts outside /api',
  });

  assert.equal(plan.diagnosis, 'the route sits inside the prefix guard, and a navigation cannot carry the header');
  assert.equal(plan.approach, 'move it out and gate it on a signed capability minted into the snapshot');
  assert.equal(plan.reason, 'the signer must exist before the route verifies one');
  assert.equal(plan.risks, 'part 2 briefly serves artifacts with no guard');
  assert.equal(plan.outOfScope, 'capability revocation');
  assert.match(plan.document!, /^# Why/);
  const part = store.plans.listPlanParts(plan.id)[0]!;
  assert.equal(part.rationale, 'a pure predicate with no callers');
  assert.equal(part.acceptance, 'mint/verify round-trip, tampered and expired both refused');
  store.close();
});

test('a document from an older planner still validates, and reads as absent', () => {
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'unchanged',
      parts: [{ slug: 'only', title: 'One', scope: 'src/', dependsOn: [] }],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const store = new Store(':memory:');
  const { plan } = ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:9', title: 'Old' });
  assert.equal(plan.diagnosis, null);
  assert.equal(plan.approach, null);
  assert.equal(plan.risks, null);
  assert.equal(plan.document, null);
  assert.equal(store.plans.listPlanParts(plan.id)[0]!.rationale, null);
  store.close();
});

test('an over-long write-up is trimmed and stored, never refused', () => {
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'one PR',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
      document: 'x'.repeat(MAX_PLAN_DOCUMENT_CHARS + 500),
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.equal(parsed.document.document!.length, MAX_PLAN_DOCUMENT_CHARS);
});

test('a part may declare an expected outcome kind, and a bad one is refused at the boundary', () => {
  const ok = validatePlanDocument({
    version: 1,
    reason: 'investigate, then fix',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/', expectedKind: 'report' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && planPartInputs(ok.document)[0]?.expectedKind, 'report');

  const bad = validatePlanDocument({
    version: 1,
    reason: 'x',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/', expectedKind: 'writeup' }],
  });
  assert.equal(bad.ok, false);

  const older = validatePlanDocument({
    version: 1,
    reason: 'x',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/' }],
  });
  assert.equal(older.ok && planPartInputs(older.document)[0]?.expectedKind, null);
});

test('a parts verdict may be entirely non-code', () => {
  const result = validatePlanDocument({
    version: 1,
    reason: 'this is an investigation, not a build',
    parts: [
      { slug: 'measure', title: 'Measure', scope: 'ci/', expectedKind: 'report' },
      { slug: 'decide', title: 'Decide', scope: 'docs/', dependsOn: ['measure'], expectedKind: 'determination' },
    ],
  });
  assert.equal(result.ok, true);
});
