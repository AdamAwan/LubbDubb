import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PLAN_FILE, isPlanFile, parsePlanDocument, planPartInputs } from '../src/plans/planDocument.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import type { Agent } from '../src/types.js';

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
    { slug: 'schema', seq: 1, title: 'Add the table', scope: 'src/store', dependsOn: [] },
    { slug: 'reader', seq: 2, title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
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
    { slug: 'schema', seq: 1, title: 'Schema', scope: 'src/store', dependsOn: [] },
    { slug: 'reader', seq: 2, title: 'Reader', scope: 'src/dispatcher', dependsOn: ['schema'] },
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
    { slug: 'schema', seq: 1, title: 'Schema (revised)', scope: 'src/store', dependsOn: [] },
    { slug: 'extra', seq: 2, title: 'Extra', scope: 'src/server', dependsOn: ['schema'] },
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
    dispatcher: 'rule',
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
  const system = buildSystem(planningConfig(), { backend: new FakePtyBackend(), errorMirror: () => {} });

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
  // re-run on the same issue every cycle.
  const b = plannerAgent(system, 'issue:13:plan');
  writeThroughHook(system, b, PLAN_FILE, '{"version":1,"verdict":"single","reason":"One PR is plenty."}');
  assert.equal(system.store.getPlanByOrigin('issue:13')?.status, 'single');

  system.store.close();
});

test('an invalid or non-planner plan.json records no plan (and an invalid one is surfaced)', () => {
  const errors: string[] = [];
  const system = buildSystem(planningConfig(), { backend: new FakePtyBackend(), errorMirror: () => {} });
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
  const system = buildSystem(planningConfig(), { backend: new FakePtyBackend(), errorMirror: () => {} });
  const agent = plannerAgent(system, 'issue:12:plan');
  writeThroughHook(system, agent, PLAN_FILE, '{"version":1,"verdict":"single","reason":"One PR."}');

  assert.deepEqual(
    system.store.listFiles(agent.id).map((f) => f.path),
    [PLAN_FILE],
  );
  assert.deepEqual(system.store.listFlags(agent.id), [], 'a side-channel file is not an artifact');
  system.store.close();
});

test('a part may declare at most one dependency, and the graph must be acyclic', () => {
  const doc = (parts: string): string => `{"version":1,"verdict":"parts","reason":"x","parts":[${parts}]}`;
  const part = (slug: string, deps: string[]): string =>
    `{"slug":"${slug}","title":"T","scope":"s","dependsOn":[${deps.map((d) => `"${d}"`).join(',')}]}`;

  // Two dependencies is the static form of "two *open* dependencies": both could be
  // in review at once and there would be no single branch to base the part on.
  const two = parsePlanDocument(doc([part('a', []), part('b', []), part('c', ['a', 'b'])].join(',')));
  assert.equal(two.ok, false);
  assert.match(two.ok === false ? two.error : '', /at most one/);

  // A cycle deadlocks every part in it — none is ever ready, and the issue silently
  // stops progressing. Reject the document so the planner is retried instead.
  const cycle = parsePlanDocument(doc([part('a', ['b']), part('b', ['a'])].join(',')));
  assert.equal(cycle.ok, false);
  assert.match(cycle.ok === false ? cycle.error : '', /dependency cycle/);

  // A chain is fine — that is exactly what a stack is.
  assert.equal(parsePlanDocument(doc([part('a', []), part('b', ['a']), part('c', ['b'])].join(','))).ok, true);
});
