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
import type { Agent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// -- the reserved filename ---------------------------------------------------

test('isPlanFile matches only the reserved path, separator-agnostically', () => {
  assert.equal(isPlanFile(PLAN_FILE), true);
  assert.equal(isPlanFile('.lubbdubb\\plan.json'), true); // Windows-reported write
  assert.equal(isPlanFile('docs/plan.json'), false);
  assert.equal(isPlanFile('sub/.lubbdubb/plan.json'), false);
  assert.equal(isPlanFile('.lubbdubb/plan.jsonc'), false);
});

// -- document validation (the zod boundary) ----------------------------------

test('parsePlanDocument accepts a single verdict and a parts verdict', () => {
  const single = parsePlanDocument('{"version":1,"verdict":"single","reason":"One small fix."}');
  assert.equal(single.ok, true);
  assert.equal(single.ok && single.document.verdict, 'single');
  assert.deepEqual(single.ok && single.document.parts, []); // defaulted

  const parts = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
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
      size: null,
      expectedKind: null,
      profile: null,
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
      size: null,
      expectedKind: null,
      profile: null,
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
  assert.match(bad('{"version":2,"verdict":"single","reason":"x"}'), /version/);
  assert.match(bad('{"version":1,"verdict":"maybe","reason":"x"}'), /verdict/);
  assert.match(bad('{"version":1,"verdict":"single"}'), /reason/);
  // A parts verdict must actually carry parts.
  assert.match(bad('{"version":1,"verdict":"parts","reason":"x","parts":[]}'), /at least one part/);
  // Structural integrity: unique slugs, resolvable and non-self dependencies.
  const part = (slug: string, dependsOn: string[]): Record<string, unknown> => ({
    slug,
    title: 't',
    scope: 's',
    dependsOn,
  });
  const doc = (parts: unknown[]): string => JSON.stringify({ version: 1, verdict: 'parts', reason: 'x', parts });
  assert.match(bad(doc([part('a', []), part('a', [])])), /duplicate slug "a"/);
  assert.match(bad(doc([part('a', ['a'])])), /depends on itself/);
  assert.match(bad(doc([part('a', ['ghost'])])), /unknown part "ghost"/);
  assert.match(bad(doc([{ slug: 'Not Kebab', title: 't', scope: 's', dependsOn: [] }])), /kebab-case/);
});

// -- store round-trip --------------------------------------------------------

test('a plan upserts by issue origin and its parts merge on slug', () => {
  const store = new Store(':memory:');
  const plan = store.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'active', reason: 'Two PRs.' });
  store.upsertPlanParts(plan.id, [
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

  // A part that has since gone into flight keeps its progress across a replan.
  const parts = store.listPlanParts(plan.id);
  assert.deepEqual(
    parts.map((p) => p.slug),
    ['schema', 'reader'],
  );
  assert.deepEqual(parts[1]?.dependsOn, ['schema']);
  assert.equal(parts[0]?.status, 'pending');

  const replanned = store.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'active', reason: 'Three.' });
  assert.equal(replanned.id, plan.id, 'the plan id is stable across a replan');
  assert.equal(replanned.createdAt, plan.createdAt);
  store.upsertPlanParts(plan.id, [
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
  const after = store.listPlanParts(plan.id);
  assert.deepEqual(
    after.map((p) => p.slug).sort(),
    ['extra', 'reader', 'schema'],
    'an amended plan merges rather than wiping in-flight parts',
  );
  assert.equal(after.find((p) => p.slug === 'schema')?.title, 'Schema (revised)');

  assert.deepEqual(
    store.listPlans().map((p) => p.originRef),
    ['issue:12'],
  );
  assert.equal(store.getPlanByOrigin('issue:99'), null);
  store.close();
});

// -- end-to-end through the file-events drain --------------------------------

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
    // Pinned off: `requireApproval` now defaults on, and this test is about
    // ingestion (the plan.json transport persisting a verdict), not the
    // approval gate — covered separately in `planApproval.test.ts`.
    planning: { requireApproval: false } as never,
  });
}

/**
 * Stand up an agent whose task looks like a planning dispatch, without needing a
 * real git worktree: the drain reads `agent.cwd`, so a temp dir is enough.
 */
function plannerAgent(system: System, originRef: string): Agent {
  const cwd = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  const task = system.store.createTask({
    kind: 'code',
    title: 'Plan issue #12',
    prompt: 'plan it',
    branch: 'plan/issue/12',
    originRef,
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, cwd);
}

/** Queue a captured write of `relPath` (with `body`) into the agent's spool. */
function writeThroughHook(system: System, agent: Agent, relPath: string, body: string): void {
  const target = join(agent.cwd, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  const spool = system.agents.fileEventsDir(agent.id);
  assert.ok(spool, 'the spawned agent has a spool dir');
  writeFileSync(join(spool!, `1-a.json`), JSON.stringify({ path: target, tool: 'Write' }));
  system.agents.drainFileEvents(agent.id);
}

test('a planner writing plan.json persists the verdict at drain time, for both outcomes', () => {
  const system = buildSystem(planningConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  // A `parts` verdict: the plan row *and* its parts land, even though nothing
  // reads the parts yet — the data only ever arrives here.
  const a = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(
    system,
    a,
    PLAN_FILE,
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'Schema first.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'reader', title: 'Reader', scope: 'src/dispatcher', dependsOn: ['schema'] },
      ],
    }),
  );
  const plan = system.store.getPlanByOrigin('issue:12');
  assert.ok(plan, 'the plan was ingested from the worktree');
  // `active`, not `awaiting_approval`: `planning.requireApproval` is pinned off
  // above, so the file transport commits a decomposition exactly as it always
  // has (issue #109 phase 3 changes only where an *opted-in* verdict lands).
  assert.equal(plan!.status, 'active');
  assert.equal(plan!.reason, 'Schema first.');
  assert.equal(plan!.title, 'Big thing', 'the issue title, not the task title');
  assert.deepEqual(
    system.store.listPlanParts(plan!.id).map((p) => p.slug),
    ['schema', 'reader'],
  );

  // A `single` verdict is a first-class row too — without it the planner would
  // re-run on the same issue every cycle. It lands `active` with no parts: the
  // status is the plan's life, the parts are its shape.
  const b = plannerAgent(system, 'issue:13:plan');
  writeThroughHook(system, b, PLAN_FILE, '{"version":1,"verdict":"single","reason":"One PR is plenty."}');
  const single = system.store.getPlanByOrigin('issue:13')!;
  assert.equal(single.status, 'active');
  assert.deepEqual(system.store.listPlanParts(single.id), []);

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

  // Malformed: no plan row, so the funnel keeps the issue and the attempt cap
  // eventually fails it open rather than persisting nonsense.
  const bad = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(system, bad, PLAN_FILE, '{"version":1,"verdict":"parts","reason":"x","parts":[]}');
  assert.equal(system.store.getPlanByOrigin('issue:12'), null);
  assert.equal(errors.filter((m) => m.includes('invalid')).length, 1);

  // A pickup agent is not a planner: its plan.json is ignored, so it can't flip
  // its own issue to `parts` and strand it while nothing schedules parts.
  const pickup = plannerAgent(system, 'issue:14');
  writeThroughHook(
    system,
    pickup,
    PLAN_FILE,
    '{"version":1,"verdict":"parts","reason":"x","parts":[{"slug":"a","title":"A","scope":"s","dependsOn":[]}]}',
  );
  assert.equal(system.store.getPlanByOrigin('issue:14'), null);

  system.store.close();
});

test('the plan file is tracked as a written file but never promoted to an artifact chip', () => {
  const system = buildSystem(planningConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const agent = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(system, agent, PLAN_FILE, '{"version":1,"verdict":"single","reason":"One PR."}');

  assert.deepEqual(
    system.store.listFiles(agent.id).map((f) => f.path),
    [PLAN_FILE],
  );
  assert.deepEqual(system.store.listFlags(agent.id), [], 'a side-channel file is not an artifact');
  system.store.close();
});

test('a part may declare several dependencies, and the graph must still be acyclic', () => {
  const doc = (parts: string): string => `{"version":1,"verdict":"parts","reason":"x","parts":[${parts}]}`;
  const part = (slug: string, deps: string[]): string =>
    `{"slug":"${slug}","title":"T","scope":"s","dependsOn":[${deps.map((d) => `"${d}"`).join(',')}]}`;

  // Several dependencies is a *rejoin*, and accepted since #170. The arity cap here
  // was the static form of "at most one *open* dependency", which is a rule about
  // the world rather than the document — a part naming two starts only once both
  // have settled, at which point neither is open. It now lives in
  // `PlanReconciler.readiness`, which can see what is in flight; see planReconcile.
  const rejoin = parsePlanDocument(doc([part('a', []), part('b', []), part('c', ['a', 'b'])].join(',')));
  assert.equal(rejoin.ok, true);
  assert.deepEqual(rejoin.ok ? rejoin.document.parts[2]?.dependsOn : null, ['a', 'b']);

  // A cycle deadlocks every part in it — none is ever ready, and the issue silently
  // stops progressing. Reject the document so the planner is retried instead.
  const cycle = parsePlanDocument(doc([part('a', ['b']), part('b', ['a'])].join(',')));
  assert.equal(cycle.ok, false);
  assert.match(cycle.ok === false ? cycle.error : '', /dependency cycle/);

  // And a cycle reachable only through a *second* dependency, which is the case the
  // walk had to be widened for: while arity was capped at one, following
  // `dependsOn[0]` was the whole graph, and `a -> [x, b]`, `b -> [a]` slips straight
  // through it. A multi-entry array makes that a real, silently deadlocking plan.
  const deep = parsePlanDocument(doc([part('x', []), part('a', ['x', 'b']), part('b', ['a'])].join(',')));
  assert.equal(deep.ok, false);
  assert.match(deep.ok === false ? deep.error : '', /dependency cycle/);

  // Self-dependency and unknown slugs are refused whatever the arity.
  const bad = parsePlanDocument(doc([part('a', []), part('b', ['a', 'nope'])].join(',')));
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.error : '', /unknown part "nope"/);

  // A chain is fine — that is exactly what a stack is, and unchanged.
  assert.equal(parsePlanDocument(doc([part('a', []), part('b', ['a']), part('c', ['b'])].join(','))).ok, true);
  // A diamond: two independent lanes off one root, rejoining. The shape #170 exists for.
  assert.equal(
    parsePlanDocument(
      doc([part('root', []), part('l', ['root']), part('r', ['root']), part('join', ['l', 'r'])].join(',')),
    ).ok,
    true,
  );
});

// -- the widened document (risks/outOfScope/document, per-part rationale/acceptance) --

test('the widened plan document round-trips through ingestion', () => {
  const store = new Store(':memory:');
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
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

  // The two the plan modal leads with, and the reason they are not folded into
  // `reason`: all three are present here and each says a different thing.
  assert.equal(plan.diagnosis, 'the route sits inside the prefix guard, and a navigation cannot carry the header');
  assert.equal(plan.approach, 'move it out and gate it on a signed capability minted into the snapshot');
  assert.equal(plan.reason, 'the signer must exist before the route verifies one');
  assert.equal(plan.risks, 'part 2 briefly serves artifacts with no guard');
  assert.equal(plan.outOfScope, 'capability revocation');
  assert.match(plan.document!, /^# Why/);
  const part = store.listPlanParts(plan.id)[0]!;
  assert.equal(part.rationale, 'a pure predicate with no callers');
  assert.equal(part.acceptance, 'mint/verify round-trip, tampered and expired both refused');
  store.close();
});

test('a document from an older planner still validates, and reads as absent', () => {
  // Every field added after v1 is optional precisely so a planner that has never
  // heard of them — or an operator-overridden prompt that does not mention them —
  // keeps working. Absent must read as null, never as an empty string, or the
  // cockpit cannot tell "wrote nothing" from "wrote ''".
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
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
  assert.equal(store.listPlanParts(plan.id)[0]!.rationale, null);
  store.close();
});

test('an over-long write-up is trimmed and stored, never refused', () => {
  // The opposite of `report_finding`, and deliberately: a finding is testimony an
  // operator acts on, so it is refused when it cannot be trusted; a write-up is
  // prose, and refusing it would reject the whole plan submission over its length.
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'single',
      reason: 'one PR',
      document: 'x'.repeat(MAX_PLAN_DOCUMENT_CHARS + 500),
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.equal(parsed.document.document!.length, MAX_PLAN_DOCUMENT_CHARS);
});

test('a part may declare an expected outcome kind, and a bad one is refused at the boundary', () => {
  const ok = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'investigate, then fix',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/', expectedKind: 'report' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && planPartInputs(ok.document)[0]?.expectedKind, 'report');

  // Synchronously, through plan_submit, rather than a pulse later.
  const bad = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'x',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/', expectedKind: 'writeup' }],
  });
  assert.equal(bad.ok, false);

  // Optional, so a plan written before the field existed still validates and reads
  // as unstated — which everything downstream treats as `code`.
  const older = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'x',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/' }],
  });
  assert.equal(older.ok && planPartInputs(older.document)[0]?.expectedKind, null);
});

test('a parts verdict may be entirely non-code', () => {
  // The case the feature exists for: "investigate why deploys are slow" decomposes
  // honestly instead of the planner inventing pull requests it can never merge.
  const result = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'this is an investigation, not a build',
    parts: [
      { slug: 'measure', title: 'Measure', scope: 'ci/', expectedKind: 'report' },
      { slug: 'decide', title: 'Decide', scope: 'docs/', dependsOn: ['measure'], expectedKind: 'determination' },
    ],
  });
  assert.equal(result.ok, true);
});
