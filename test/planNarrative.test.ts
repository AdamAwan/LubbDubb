import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanDocument, planNarrative, planPartInputs } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { latestPlanDiff } from '../src/plans/planDiff.js';
import { planScopeDrift } from '../src/plans/scopeDrift.js';
import { acceptanceCriteria, partDeclarationNote } from '../src/plans/parts.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import { Store } from '../src/store/store.js';
import type { AgentFile, Plan, PlanPart, PlanRevision, Task } from '../src/types.js';
import type { PlanHistory } from '../src/wire.js';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { gitRepo } from './support/gitRepo.js';

/**
 * The plan document's second version, and the three readings it made possible:
 * the amendment diff, the scope check and the acceptance checklist.
 *
 * Everything here is either the store or a pure function, so none of it needs a
 * system — the paths that *dispatch* on these fields are covered where they live
 * (`test/planPart.test.ts`, `test/planIngestion.test.ts`).
 */

function store(): Store {
  return new Store(':memory:');
}

const DOC = {
  version: 1 as const,
  reason: 'The schema has to land before the reader.',
  diagnosis: 'The cache key is written from the old value in `src/cache.ts`.',
  approach: 'Key the write off the new value and add the regression test.',
  verification: 'A second read after a refresh returns the new value.',
  alternatives: 'Invalidate on write instead — rejected, it makes every read a round trip.',
  openQuestions: 'Whether the TTL should shrink as well.',
  risks: 'The regression test needs a clock seam that does not exist yet.',
  outOfScope: 'The TTL itself.',
  evidence: [{ path: 'src/cache.ts', line: 88, note: 'writes under the old key' }],
  document: '# Why\n\nBecause the key is stale.',
  parts: [
    {
      slug: 'schema',
      title: 'Add the table',
      scope: 'The store, and nothing that reads it.',
      touches: ['src/store/'],
      size: 's' as const,
      dependsOn: [],
      rationale: 'Nothing behaves differently until the reader lands.',
      acceptance: '- The table exists.\n- The migration runs clean.',
    },
    {
      slug: 'reader',
      title: 'Read it',
      scope: 'The dispatcher.',
      touches: ['src/dispatcher/'],
      size: 'm' as const,
      dependsOn: ['schema'],
      acceptance: 'The dispatcher reads the new table.',
    },
  ],
};

// -- the document ------------------------------------------------------------

test('the v2 fields round-trip through the schema and onto the plan row', () => {
  const parsed = parsePlanDocument(JSON.stringify(DOC));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const narrative = planNarrative(parsed.document);
  assert.equal(narrative.alternatives, DOC.alternatives);
  assert.equal(narrative.openQuestions, DOC.openQuestions);
  assert.equal(narrative.verification, DOC.verification);
  assert.deepEqual(narrative.evidence, [{ path: 'src/cache.ts', line: 88, note: 'writes under the old key' }]);

  const [first] = planPartInputs(parsed.document);
  assert.deepEqual(first?.touches, ['src/store/']);
  assert.equal(first?.size, 's');

  const s = store();
  const { plan } = ingestPlanDocument(s, { doc: parsed.document, originRef: 'issue:12', title: 'Issue 12' });
  const read = s.getPlan(plan.id);
  assert.equal(read?.alternatives, DOC.alternatives);
  assert.equal(read?.verification, DOC.verification);
  assert.deepEqual(read?.evidence[0], { path: 'src/cache.ts', line: 88, note: 'writes under the old key' });
  const parts = s.listPlanParts(plan.id);
  assert.deepEqual(parts[0]?.touches, ['src/store/']);
  assert.equal(parts[1]?.size, 'm');
});

test('a v1 document still validates, and reads back with the v2 fields empty', () => {
  const parsed = parsePlanDocument(
    '{"version":1,"reason":"One small fix.","parts":[{"slug":"whole","title":"The fix","scope":"src/"}]}',
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const s = store();
  const { plan } = ingestPlanDocument(s, { doc: parsed.document, originRef: 'issue:9', title: 'Issue 9' });
  const read = s.getPlan(plan.id);
  assert.equal(read?.alternatives, null);
  assert.equal(read?.openQuestions, null);
  assert.equal(read?.verification, null);
  assert.deepEqual(read?.evidence, []);
});

test('an amendment that omits the narrative leaves the previous one standing', () => {
  const s = store();
  const parsed = parsePlanDocument(JSON.stringify(DOC));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  ingestPlanDocument(s, { doc: parsed.document, originRef: 'issue:12', title: 'Issue 12' });
  // The same discipline `risks` already had: a caller updating only what it knows
  // about must not erase a narrative some other write put there.
  const plan = s.upsertPlan({ originRef: 'issue:12', title: 'Issue 12', status: 'active' });
  assert.equal(plan.alternatives, DOC.alternatives);
  assert.deepEqual(plan.evidence.length, 1);
});

// -- revisions and the diff --------------------------------------------------

test('every ingestion records a revision, numbered in order', () => {
  const s = store();
  const parsed = parsePlanDocument(JSON.stringify(DOC));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const { plan } = ingestPlanDocument(s, { doc: parsed.document, originRef: 'issue:12', title: 'Issue 12' });
  ingestPlanDocument(s, { doc: parsed.document, originRef: 'issue:12', title: 'Issue 12' });

  const revisions = s.listPlanRevisions(plan.id);
  assert.deepEqual(
    revisions.map((r) => r.seq),
    [1, 2],
  );
  assert.equal(revisions[0]?.narrative.diagnosis, DOC.diagnosis);
  assert.equal(revisions[0]?.parts.length, 2);
  // The declaration is stored whole, so a replan can be read as a change to it.
  assert.deepEqual(revisions[0]?.parts[0]?.touches, ['src/store/']);
});

test('a revision records what was proposed, not what the store made of it', () => {
  const s = store();
  const parsed = parsePlanDocument(JSON.stringify(DOC));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const { plan } = ingestPlanDocument(s, { doc: parsed.document, originRef: 'issue:12', title: 'Issue 12' });
  // `schema` is in review, so an amendment dropping it cannot retire it.
  const schema = s.listPlanParts(plan.id).find((p) => p.slug === 'schema');
  assert.ok(schema);
  s.updatePlanPart(schema.id, { status: 'in_review', prNumber: 7 });

  const amended = parsePlanDocument(JSON.stringify({ ...DOC, parts: [{ ...DOC.parts[1], dependsOn: [] }] }));
  assert.equal(amended.ok, true);
  if (!amended.ok) return;
  ingestPlanDocument(s, { doc: amended.document, originRef: 'issue:12', title: 'Issue 12' });

  // Live on the plan — `partsToRetire` spared it — and absent from the new
  // revision, because the planner did not declare it. Both readings are true.
  assert.equal(s.listPlanParts(plan.id).find((p) => p.slug === 'schema')?.status, 'in_review');
  const diff = latestPlanDiff(s.listPlanRevisions(plan.id));
  assert.equal(diff?.parts.find((p) => p.slug === 'schema')?.kind, 'dropped');
});

test('the diff names changed fields, and is null for a plan with one verdict', () => {
  const before = revision(1, [
    { slug: 'a', seq: 1, title: 'A', scope: 'x', touches: ['src/a/'], dependsOn: [], size: 's' },
    { slug: 'b', seq: 2, title: 'B', scope: 'y', touches: [], dependsOn: ['a'], size: null },
  ]);
  const after = revision(2, [
    // `seq` moved and nothing else — deliberately *not* a change, or inserting one
    // part would mark half a decomposition as amended.
    { slug: 'a', seq: 2, title: 'A', scope: 'x', touches: ['src/a/'], dependsOn: [], size: 's' },
    { slug: 'c', seq: 1, title: 'C', scope: 'z', touches: [], dependsOn: [], size: null },
  ]);
  assert.equal(latestPlanDiff([before]), null);

  const diff = latestPlanDiff([before, after]);
  assert.equal(diff?.seq, 2);
  assert.equal(diff?.againstSeq, 1);
  assert.equal(diff?.parts.find((p) => p.slug === 'a')?.kind, 'unchanged');
  assert.equal(diff?.parts.find((p) => p.slug === 'c')?.kind, 'added');
  assert.equal(diff?.parts.find((p) => p.slug === 'b')?.kind, 'dropped');
});

test('a re-ordered dependency list is not a change, but a new dependency is', () => {
  const before = revision(1, [
    { slug: 'a', seq: 1, title: 'A', scope: 'x', touches: [], dependsOn: ['x', 'y'], size: null },
  ]);
  const same = revision(2, [
    { slug: 'a', seq: 1, title: 'A', scope: 'x', touches: [], dependsOn: ['y', 'x'], size: null },
  ]);
  assert.equal(latestPlanDiff([before, same])?.parts[0]?.kind, 'unchanged');

  const more = revision(2, [
    { slug: 'a', seq: 1, title: 'A', scope: 'x', touches: [], dependsOn: ['x', 'y', 'z'], size: null },
  ]);
  const fields = latestPlanDiff([before, more])?.parts[0]?.fields ?? [];
  assert.deepEqual(
    fields.map((f) => f.field),
    ['dependsOn'],
  );
});

test('narrative changes are named, and a written field is told apart from a rewritten one', () => {
  const before = revision(1, [], { approach: 'Do the thing.' });
  const after = revision(2, [], { approach: 'Do the other thing.', alternatives: 'Considered X.' });
  const diff = latestPlanDiff([before, after]);
  assert.deepEqual(diff?.narrative, [
    { field: 'approach', kind: 'rewritten' },
    { field: 'alternatives', kind: 'written' },
  ]);
});

// -- scope drift -------------------------------------------------------------

test('scope drift reports writes outside a declared prefix, and nothing for an undeclared part', () => {
  const declared = part('schema', { touches: ['src/store/', 'src/system.ts'] });
  const silent = part('reader', { touches: [] });
  const tasks: Task[] = [task('issue:12:part:schema', 'agent-1'), task('issue:12:part:reader', 'agent-2')];
  const files: AgentFile[] = [
    file('agent-1', 'src/store/plans.ts'),
    file('agent-1', 'src/system.ts'),
    // Outside: the prefix test is on a path segment, so `src/storefront` is not
    // covered by `src/store/`.
    file('agent-1', 'src/storefront/x.ts'),
    file('agent-1', 'docs/spec/14-persistence.md'),
    file('agent-2', 'anything/at/all.ts'),
  ];

  const drift = planScopeDrift(12, [declared, silent], tasks, files);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.partId, declared.id);
  assert.deepEqual(drift[0]?.paths, ['src/storefront/x.ts', 'docs/spec/14-persistence.md']);
});

/**
 * The declaration a sweep or a tree-wide rename writes. `.` is the spelling
 * `pathIsInside`'s own comment names first, and the one that used to survive
 * normalisation as a literal prefix nothing matches — so a part that declared the
 * widest possible scope had every file it wrote drawn under a drift line.
 */
test('the four spellings of the repository are one declaration, and none of them drift', () => {
  const tasks: Task[] = [task('issue:12:part:sweep', 'agent-1')];
  const files: AgentFile[] = [file('agent-1', 'src/store/plans.ts'), file('agent-1', 'README.md')];
  for (const touches of [['.'], ['./'], ['/'], [''], [' . ']]) {
    const declared = part('sweep', { touches });
    assert.deepEqual(
      planScopeDrift(12, [declared], tasks, files),
      [],
      `${JSON.stringify(touches)} declares the repository, so nothing is outside it`,
    );
  }
});

test('scope drift reads every agent a part had, not only its last', () => {
  const declared = part('schema', { touches: ['src/store/'] });
  const tasks: Task[] = [task('issue:12:part:schema', 'agent-1'), task('issue:12:part:schema', 'agent-2')];
  const files: AgentFile[] = [file('agent-1', 'src/wire.ts'), file('agent-2', 'src/store/plans.ts')];
  // The first attempt stalled and was re-dispatched; its writes are on the branch
  // just as much as the second's.
  assert.deepEqual(planScopeDrift(12, [declared], tasks, files)[0]?.paths, ['src/wire.ts']);
});

// -- acceptance --------------------------------------------------------------

test('acceptance splits on lines, strips list markers and folds in the ticks', () => {
  const p = part('schema', {
    acceptance: '- The table exists.\n2. The migration runs clean.\n\n* Nothing else changes.',
    acceptanceMet: ['The migration runs clean.'],
  });
  assert.deepEqual(acceptanceCriteria(p), [
    { text: 'The table exists.', met: false },
    { text: 'The migration runs clean.', met: true },
    { text: 'Nothing else changes.', met: false },
  ]);
  assert.deepEqual(acceptanceCriteria(part('x', { acceptance: null })), []);
});

test('a re-worded criterion loses its tick, because the text is the key', () => {
  const p = part('schema', { acceptance: 'The table exists and is indexed.', acceptanceMet: ['The table exists.'] });
  assert.deepEqual(acceptanceCriteria(p), [{ text: 'The table exists and is indexed.', met: false }]);
});

// -- what the part agent is told ---------------------------------------------

test('the declaration note carries the paths and the criteria, and is empty without them', () => {
  const note = partDeclarationNote(part('schema', { touches: ['src/store/'], acceptance: 'The table exists.' }));
  assert.match(note, /src\/store\//);
  assert.match(note, /done when/i);
  assert.equal(partDeclarationNote(part('bare', { touches: [], acceptance: null })), '');
});

// -- the tracker comment -----------------------------------------------------

test('the status comment carries the planner narrative, folded, once there is one', () => {
  const plan = {
    id: 'p1',
    originRef: 'issue:12',
    title: 'Issue 12',
    status: 'active' as const,
    diagnosis: 'The key is stale.',
    approach: 'Write it under the new key.',
    reason: 'Two reviewable pieces.',
    risks: 'A clock seam is missing.',
    outOfScope: 'The TTL.',
    alternatives: 'Invalidate on write — rejected.',
    openQuestions: 'Whether the TTL shrinks.',
    verification: 'A second read returns the new value.',
    evidence: [{ path: 'src/cache.ts', line: 88, note: 'the stale write' }],
    document: '# Why\n\nBecause.',
    discussing: false,
    statusCommentRef: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const body = renderPlanComment(plan, [part('schema', {})], '#');
  assert.match(body, /<details>/);
  assert.match(body, /What's wrong/);
  assert.match(body, /How we'll know it worked/);
  assert.match(body, /Considered and rejected/);
  assert.match(body, /src\/cache\.ts:88/);
  assert.match(body, /The full write-up/);
  // Caveats *on the verdict*, addressed to whoever was deciding whether the work
  // happens — and that decision is already made by the time this is written.
  assert.doesNotMatch(body, /Whether the TTL shrinks/);
  assert.doesNotMatch(body, /A clock seam is missing/);

  // A plan whose planner wrote none of it renders exactly as it did before.
  const bare = renderPlanComment(
    {
      ...plan,
      diagnosis: null,
      approach: null,
      verification: null,
      alternatives: null,
      outOfScope: null,
      evidence: [],
      document: null,
    },
    [part('schema', {})],
    '#',
  );
  assert.doesNotMatch(bare, /<details>/);
});

// -- helpers -----------------------------------------------------------------

function part(slug: string, over: Partial<PlanPart>): PlanPart {
  return {
    id: `p1:${slug}`,
    planId: 'p1',
    slug,
    seq: 1,
    title: slug,
    scope: 'x',
    touches: [],
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
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

/** The declaration half of a part, with the three fields these graphs never vary. */
type Declared = Omit<PlanRevision['parts'][number], 'rationale' | 'acceptance' | 'expectedKind'>;

function revision(seq: number, parts: Declared[], narrative: Partial<PlanRevision['narrative']> = {}): PlanRevision {
  return {
    id: `rev-${seq}`,
    planId: 'p1',
    seq,
    at: '2026-08-01T00:00:00.000Z',
    parts: parts.map((p) => ({ rationale: null, acceptance: null, expectedKind: null, ...p })),
    narrative: {
      reason: null,
      diagnosis: null,
      approach: null,
      risks: null,
      outOfScope: null,
      alternatives: null,
      openQuestions: null,
      verification: null,
      document: null,
      evidence: [],
      ...narrative,
    },
  };
}

function task(originRef: string, agentId: string): Task {
  return {
    id: `t-${agentId}`,
    title: originRef,
    status: 'running',
    kind: 'code',
    agentId,
    originRef,
    originTitle: null,
    originSummary: null,
    prompt: '',
    dispatchReason: null,
    branch: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function file(agentId: string, path: string): AgentFile {
  return {
    id: `${agentId}:${path}`,
    agentId,
    path,
    tool: 'Edit',
    promoted: false,
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

// -- the routes --------------------------------------------------------------

test('GET /api/plans/:id/history ships the revisions and the last amendment as a diff', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedPlan(system);
  const amended = parsePlanDocument(
    JSON.stringify({ ...DOC, approach: 'Something else entirely.', parts: [DOC.parts[0]] }),
  );
  assert.ok(amended.ok);
  ingestPlanDocument(system.store, { doc: amended.document, originRef: 'issue:231', title: 'Big thing' });

  const res = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/history` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as PlanHistory;
  assert.equal(body.revisions.length, 2);
  assert.equal(body.diff?.parts.find((p) => p.slug === 'reader')?.kind, 'dropped');
  assert.deepEqual(
    body.diff?.narrative.map((n) => n.field),
    ['approach'],
  );

  const missing = await app.inject({ method: 'GET', url: '/api/plans/nope/history' });
  assert.equal(missing.statusCode, 404);
  await app.close();
  system.store.close();
});

test('POST /api/plans/:id/acceptance ticks a criterion, and refuses one the part does not declare', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedPlan(system);

  const ok = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/acceptance`,
    payload: { slug: 'schema', criterion: 'The table exists.', met: true },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(system.store.listPlanParts(plan.id).find((p) => p.slug === 'schema')?.acceptanceMet, [
    'The table exists.',
  ]);

  // Refused rather than stored: a tick against text no criterion carries could
  // never be drawn again, so accepting it would report a confirmation the sheet
  // would then not show.
  const bogus = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/acceptance`,
    payload: { slug: 'schema', criterion: 'Something nobody declared.', met: true },
  });
  assert.equal(bogus.statusCode, 409);

  const unknownPart = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/acceptance`,
    payload: { slug: 'nope', criterion: 'The table exists.', met: true },
  });
  assert.equal(unknownPart.statusCode, 404);

  // Un-ticking is the same route, and leaves nothing behind.
  await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/acceptance`,
    payload: { slug: 'schema', criterion: 'The table exists.', met: false },
  });
  assert.deepEqual(system.store.listPlanParts(plan.id).find((p) => p.slug === 'schema')?.acceptanceMet, []);
  await app.close();
  system.store.close();
});

async function buildTestApp(): Promise<{ system: System; app: FastifyInstance }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    // A throwaway repo rather than the ambient `cwd` default — see
    // `test/planDiscussion.test.ts` for why a plan test must never point the real
    // worktree manager at the checkout the suite is running in.
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  return { system, app };
}

/** The two-part plan above, ingested against a real issue. */
function seedPlan(system: System): Plan {
  system.connector.inject({ kind: 'new_issue', number: 231, title: 'Big thing', body: 'Several PRs.' });
  const doc = parsePlanDocument(JSON.stringify(DOC));
  assert.ok(doc.ok);
  return ingestPlanDocument(system.store, { doc: doc.document, originRef: 'issue:231', title: 'Big thing' }).plan;
}
