import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { committableFact, graduationNote, graduationReading } from '../src/knowledge/graduation.js';
import { KnowledgeGraduationDesk } from '../src/knowledge/graduationDesk.js';
import { renderKnowledgeBlock } from '../src/knowledge/block.js';
import type { KnowledgeFact, KnowledgeGraduation, WorkNode } from '../src/types.js';

/**
 * Graduation (issue #27 phase 6,
 * `docs/spec/27-knowledge.md#committing-to-the-repository`): committing a claim to
 * the repository, and the claim leaving every prompt when that pull request lands.
 *
 * Everything worth asserting here is about the two silent failures the design is
 * arranged around. **A claim taken out of prompts too early** is one the fleet
 * stops being told for a pull request that may never merge — so the commit moves
 * nothing, and the sweep will not act on a merge it only inferred. **A landing
 * missed** leaves the claim injected forever, paying context twice for a sentence
 * the repository now states — so the landing is swept for out of the durable work
 * graph rather than hooked onto a transition the harness can be restarted through.
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-graduation-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    // `worktrees` because committing dispatches a **code** agent: without the fake,
    // the manual cycle the route runs cuts a real branch in whatever checkout the
    // suite is running in. → CLAUDE.md, "Tests".
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

async function serve(system: System): Promise<FastifyInstance> {
  const { app } = await buildApp(system);
  return app;
}

const CLAIM = 'A route handler never reads the request: it is handed the parsed body by `checked`.';

/** A standing fleet claim two goals corroborated and an operator injected — the ordinary thing to commit. */
function injectedClaim(system: System, claim = CLAIM): KnowledgeFact {
  const seen = (goalRef: string) => ({
    agentId: `agent_${goalRef}`,
    taskId: `task_${goalRef}`,
    goalRef,
    sessionId: null,
    words: `I hit this on ${goalRef}, and the handler was already holding a parsed body.`,
  });
  const proposal = {
    claim,
    scope: 'fleet' as const,
    lifetime: 'standing' as const,
    expiresInHours: null,
    evidence: 'the route cast the body and the 400 came out of setErrorHandler.',
    supersedes: null,
    resolvesWhen: null,
    aboutRef: null,
    where: null,
  };
  const filed = system.store.proposeFact(proposal, seen('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  system.store.proposeFact(proposal, seen('issue:42'));
  return system.store.setFactReach(filed.fact.id, 'injected')!;
}

/** One commit request, as the status and whatever came back with it. */
async function commit(app: FastifyInstance, id: string, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: `/api/knowledge/facts/${id}/commit`, payload: body });
  const json = res.json() as { error?: string; job?: { id: string; kind: string; title: string; prompt: string } };
  return { status: res.statusCode, error: json.error ?? '', job: json.job };
}

/**
 * What the world graph says about the job's pull request, written straight into the
 * graph the sweep reads. The recorder folds these from a world snapshot on every
 * pulse; what the sweep needs is only the node it leaves behind.
 */
function graphSays(system: System, jobId: string, pr: Partial<WorkNode> & { ref: string }): void {
  system.store.recordWorkGraph([
    { ref: `job:${jobId}`, kind: 'job', title: 'Document: a claim', status: 'dispatched', terminal: false },
    {
      kind: 'pr',
      parentRef: `job:${jobId}`,
      title: 'docs: a claim',
      status: 'open',
      terminal: false,
      ...pr,
    } as Parameters<System['store']['recordWorkGraph']>[0][number],
  ]);
}

// -- the click ----------------------------------------------------------------

test('committing a claim opens documentation work and moves the claim nowhere', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);

  const res = await commit(app, fact.id, { target: 'spec' });
  assert.equal(res.status, 200);
  // A **code** job: writing a documentation change and opening a pull request for
  // it means files in a tree, so it wants a worktree and a branch.
  assert.equal(res.job?.kind, 'code');
  assert.match(res.job?.title ?? '', /^Document: /);

  // And the whole of the intermediate state: the claim is exactly where it was.
  // Taken out of every prompt here, it would be a claim the fleet stops being told
  // while a pull request sits in review — and if that pull request never merges,
  // one nobody is told and nobody can read, with nothing red.
  const after = system.store.getFact(fact.id)!;
  assert.equal(after.reach, 'injected');
  assert.ok(system.store.askFacts({}).some((f) => f.id === fact.id));
  assert.ok(renderKnowledgeBlock(system.store.askFacts({}), 8_000).text.includes(CLAIM));

  const graduation = system.store.listGraduations().find((g) => g.factId === fact.id)!;
  assert.equal(graduation.jobId, res.job?.id);
  assert.equal(graduation.outcome, null);
  assert.equal(graduation.prRef, null);

  // One at a time: a second docs job for one claim is two agents writing the same
  // paragraph into two pull requests, and whichever landed first would settle a
  // graduation the other was still working.
  assert.equal((await commit(app, fact.id, { target: 'spec' })).status, 409);
  assert.equal((await commit(app, 'fact_nothing', { target: 'spec' })).status, 404);
  await app.close();
});

test('the prompt carries the claim, what was seen, and where the operator says it goes', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);
  const { job } = await commit(app, fact.id, { target: 'spec' });

  // The `docs-change` template a promoted `docs` finding already renders — one
  // override for both, rather than a second copy of it to keep in step.
  assert.match(job?.prompt ?? '', /open a pull request/i);
  assert.match(job?.prompt ?? '', /not a direct push/i);
  assert.match(job?.prompt ?? '', /check it against the code/i);
  // The claim itself, and the observations behind it: the agent is being asked to
  // check the claim, and the evidence is the argument for it.
  assert.match(job?.prompt ?? '', /never reads the request/);
  assert.match(job?.prompt ?? '', /I hit this on issue:41/);
  // A `{token}` reaching an agent is a prompt bug.
  assert.doesNotMatch(job?.prompt ?? '', /\{\w+\}/);
  // The default target says out loud that it is *not* the file loaded on every
  // dispatch, so an agent does not put it there for want of being told.
  assert.match(job?.prompt ?? '', /Not CLAUDE\.md/);
  await app.close();
});

test('CLAUDE.md costs a sentence, and the sentence reaches the agent', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);

  // The bar is carried by the body's *shape*, so a graduation to the file that is
  // paid for on every dispatch cannot be made by forgetting a field.
  assert.equal((await commit(app, fact.id, { target: 'claudeMd' })).status, 400);
  assert.equal((await commit(app, fact.id, { target: 'claudeMd', bar: '  ' })).status, 400);

  const bar = 'A handler that reads the request itself compiles, passes and 400s out of setErrorHandler.';
  const { status, job } = await commit(app, fact.id, { target: 'claudeMd', bar });
  assert.equal(status, 200);
  assert.match(job?.prompt ?? '', /CLAUDE\.md/);
  assert.ok(job?.prompt.includes(bar), 'the operator’s reason does not reach the agent writing the entry');
  // And it is checked rather than obeyed: the length of that file is asserted
  // rather than intended, so a line that does not meet the bar costs every
  // dispatch from now on with nothing ever going red about it.
  assert.match(job?.prompt ?? '', /Check that reading/i);
  await app.close();
});

test('what the store will not commit, and why', async () => {
  const system = build();
  const app = await serve(system);

  // A proposal reaches nobody: committing it would put a claim nothing has agreed
  // with into the repository through an agent, which is the auto-promotion this
  // store exists to prevent arriving through the one door that ends outside it.
  const lone = system.store.proposeFact(
    {
      claim: 'One agent said this and nothing has agreed.',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'saw it once.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: null, taskId: null, goalRef: 'issue:9', sessionId: null, words: 'saw it once.' },
  );
  assert.ok(lone.outcome !== 'barred');
  const refused = await commit(app, lone.fact.id, { target: 'spec' });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /nothing has agreed/);

  // A notice is a report on today and ends by itself; the repository is for what
  // stays true. Committing one writes this afternoon into a document that outlives
  // it by years, and the fact's own lapse then takes the claim out of prompts it is
  // no longer in while the document goes on saying it.
  const notice = system.store.proposeFact(
    {
      claim: 'The check `test (windows)` has been timing out at the install step all afternoon.',
      scope: 'check:test (windows)',
      lifetime: 'expiring',
      expiresInHours: 6,
      evidence: 'two runs, same step.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: null, taskId: null, goalRef: 'pr:1', sessionId: null, words: 'two runs, same step.' },
  );
  assert.ok(notice.outcome !== 'barred');
  system.store.proposeFact(
    {
      claim: 'The check `test (windows)` has been timing out at the install step all afternoon.',
      scope: 'check:test (windows)',
      lifetime: 'expiring',
      expiresInHours: 6,
      evidence: 'again.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: null, taskId: null, goalRef: 'pr:2', sessionId: null, words: 'again.' },
  );
  const noticeRefusal = await commit(app, notice.fact.id, { target: 'spec' });
  assert.equal(noticeRefusal.status, 409);
  assert.match(noticeRefusal.error, /report on today/);
  await app.close();
});

// -- the landing --------------------------------------------------------------

test('a claim reaches committed when its pull request lands, and not when the job is queued', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);
  const { job } = await commit(app, fact.id, { target: 'spec' });
  const desk = new KnowledgeGraduationDesk({ store: system.store });

  // Open: nothing settles, and the claim is still being delivered.
  graphSays(system, job!.id, { ref: 'pr:77' });
  desk.run();
  assert.equal(system.store.getFact(fact.id)?.reach, 'injected');
  // The reference is stamped as soon as there is one, because a row that names a
  // pull request and offers no way there is a dead end — and the graph's memory of
  // *which job* opened it is only as long as the job list the fold reads.
  assert.equal(system.store.listGraduations()[0]?.prRef, 'pr:77');

  // Merged, and observed: the claim is in the repository, so it leaves every prompt.
  graphSays(system, job!.id, { ref: 'pr:77', status: 'merged', terminal: true, provenance: 'observed' });
  desk.run();
  assert.equal(system.store.getFact(fact.id)?.reach, 'graduated');
  assert.equal(system.store.listGraduations()[0]?.outcome, 'landed');
  assert.equal(
    system.store.askFacts({}).find((f) => f.id === fact.id),
    undefined,
  );
  assert.ok(!renderKnowledgeBlock(system.store.askFacts({}), 8_000).text.includes(CLAIM));

  // Idempotent: a sweep that runs twice cannot re-settle a row or re-move a reach.
  desk.run();
  assert.equal(system.store.listGraduations().length, 1);
  await app.close();
});

test('a pull request closed unmerged leaves the claim exactly where it was', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);
  const { job } = await commit(app, fact.id, { target: 'spec' });
  const desk = new KnowledgeGraduationDesk({ store: system.store });

  graphSays(system, job!.id, { ref: 'pr:78', status: 'closed', terminal: true, provenance: 'observed' });
  desk.run();
  // Nobody committed the claim, so it is still true, still injected and still
  // delivered — and the row that did not land stays, because an operator deciding
  // whether to try again needs to know one was tried.
  assert.equal(system.store.getFact(fact.id)?.reach, 'injected');
  assert.equal(system.store.listGraduations()[0]?.outcome, 'abandoned');
  assert.ok(system.store.askFacts({}).some((f) => f.id === fact.id));
  // And it can be committed again: the refusal was on a graduation still going.
  assert.equal((await commit(app, fact.id, { target: 'spec' })).status, 200);
  await app.close();
});

test('an inferred merge settles nothing, and the operator answers it', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);
  const { job } = await commit(app, fact.id, { target: 'spec' });
  const desk = new KnowledgeGraduationDesk({ store: system.store });

  // Absence-means-merged is a sane default for a lens and is not one here: acting
  // on it takes a claim out of every prompt for a pull request that may have been
  // closed unmerged while nothing was watching.
  graphSays(system, job!.id, { ref: 'pr:79', status: 'merged', terminal: true, provenance: 'inferred' });
  desk.run();
  assert.equal(system.store.getFact(fact.id)?.reach, 'injected');
  assert.equal(system.store.listGraduations()[0]?.outcome, null);

  // The page draws that reading, so the one party who can say does.
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeGraduations: { id: string; reading: string; prRef: string | null }[];
  };
  assert.equal(snap.knowledgeGraduations[0]?.reading, 'unknown');
  assert.equal(snap.knowledgeGraduations[0]?.prRef, 'pr:79');

  const id = snap.knowledgeGraduations[0]!.id;
  const settled = await app.inject({
    method: 'POST',
    url: `/api/knowledge/graduations/${id}/settle`,
    payload: { outcome: 'landed' },
  });
  assert.equal(settled.statusCode, 200);
  assert.equal(system.store.getFact(fact.id)?.reach, 'graduated');
  // Answered once and not twice.
  const again = await app.inject({
    method: 'POST',
    url: `/api/knowledge/graduations/${id}/settle`,
    payload: { outcome: 'abandoned' },
  });
  assert.equal(again.statusCode, 409);
  await app.close();
});

// -- the pure readings --------------------------------------------------------

function graduation(overrides: Partial<KnowledgeGraduation> = {}): KnowledgeGraduation {
  return {
    id: 'kng_1',
    factId: 'fact_1',
    exit: 'docs',
    jobId: 'j1',
    target: 'spec',
    bar: null,
    prRef: null,
    ticketRef: null,
    outcome: null,
    settledAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function node(overrides: Partial<WorkNode> & { ref: string; kind: WorkNode['kind'] }): WorkNode {
  return {
    parentRef: null,
    baseRef: null,
    title: 'x',
    status: 'open',
    terminal: false,
    provenance: null,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('the three verdicts, and the fourth that is not one', () => {
  const g = graduation();
  const pr = (over: Partial<WorkNode>) => node({ ref: 'pr:1', kind: 'pr', parentRef: 'job:j1', ...over });

  assert.equal(graduationReading(g, []), 'waiting');
  assert.equal(graduationReading(g, [pr({})]), 'waiting');
  assert.equal(graduationReading(g, [pr({ status: 'merged', terminal: true, provenance: 'observed' })]), 'landed');
  assert.equal(graduationReading(g, [pr({ status: 'closed', terminal: true, provenance: 'observed' })]), 'abandoned');
  // The verdict a narrower reading would fold into `landed`, and must not.
  assert.equal(graduationReading(g, [pr({ status: 'merged', terminal: true, provenance: 'inferred' })]), 'unknown');
  // A job cancelled before it opened anything is the one way "no pull request"
  // becomes final: the operator dropped it.
  assert.equal(
    graduationReading(g, [node({ ref: 'job:j1', kind: 'job', status: 'cancelled', terminal: true })]),
    'abandoned',
  );
  // A pull request under somebody else's work is not this job's, whatever it says.
  assert.equal(
    graduationReading(g, [pr({ parentRef: 'issue:41', status: 'merged', terminal: true, provenance: 'observed' })]),
    'waiting',
  );
  // A settled row answers with what it was settled as, whatever the graph now says.
  assert.equal(graduationReading(graduation({ outcome: 'abandoned' }), [pr({ status: 'merged' })]), 'abandoned');
});

test('what may be committed, and the wording of each refusal', () => {
  const base: KnowledgeFact = {
    id: 'fact_1',
    claim: CLAIM,
    scope: 'fleet',
    lifetime: 'standing',
    expiresAt: null,
    reach: 'injected',
    supersedes: null,
    originRef: 'issue:41',
    ruledAt: null,
    resolvesWhen: null,
    aboutRef: null,
    where: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  assert.equal(committableFact(base).ok, true);
  assert.equal(committableFact({ ...base, reach: 'lookup' }).ok, true);
  for (const reach of ['proposal', 'graduated', 'rejected', 'superseded'] as const) {
    assert.equal(committableFact({ ...base, reach }).ok, false, `${reach} is committable`);
  }
  assert.equal(committableFact({ ...base, lifetime: 'expiring', expiresAt: '2026-09-01T00:00:00.000Z' }).ok, false);
});

test('the note says what the landing costs the claim, whichever target it names', () => {
  const fact: KnowledgeFact = {
    id: 'fact_1',
    claim: CLAIM,
    scope: 'check:test (windows)',
    lifetime: 'standing',
    expiresAt: null,
    reach: 'injected',
    supersedes: null,
    originRef: 'issue:41',
    ruledAt: null,
    resolvesWhen: null,
    aboutRef: null,
    where: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const observations = Array.from({ length: 9 }, (_, i) => ({
    id: `knc_${i}`,
    factId: 'fact_1',
    agentId: null,
    taskId: null,
    goalRef: `issue:${i}`,
    sessionId: null,
    words: `observation ${i}`,
    createdAt: '2026-08-01T00:00:00.000Z',
  }));
  const note = graduationNote(fact, { exit: 'docs', target: 'spec' }, observations);
  // The consequence of the pull request landing, said where the agent writing the
  // document reads it: a thinner sentence than the claim is a net loss.
  assert.match(note, /leaves every prompt/);
  // Bounded, and the bound is said rather than a silent truncation — a prompt that
  // grew with the corroboration count would be a dispatch priced by how popular a
  // claim was.
  assert.match(note, /observation 0/);
  assert.doesNotMatch(note, /observation 8/);
  assert.match(note, /3 further observations/);
  assert.match(note, /test \(windows\)/);

  const claudeMd = graduationNote(
    fact,
    { exit: 'docs', target: 'claudeMd', bar: 'nothing goes red when you get it wrong' },
    [],
  );
  assert.match(claudeMd, /nothing goes red when you get it wrong/);
  assert.match(claudeMd, /asserted rather than intended/);
});
