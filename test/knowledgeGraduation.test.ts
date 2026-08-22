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
import { exitableFact, graduationNote, graduationReading } from '../src/knowledge/graduation.js';
import { KnowledgeGraduationDesk } from '../src/knowledge/graduationDesk.js';
import { renderKnowledgeBlock } from '../src/knowledge/block.js';
import type { KnowledgeFact, KnowledgeGraduation, WorkNode } from '../src/types.js';

/**
 * Graduation (`docs/spec/27-knowledge.md#sending-a-claim-on`): the three ways a
 * claim leaves this store, and the claim leaving every prompt when the exit is
 * actually taken.
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
  const res = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${id}/exit`,
    payload: { exit: 'docs', ...body },
  });
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

// -- the other two exits ------------------------------------------------------

/**
 * A `job` and a `ticket` were `POST /api/findings/:id/promote` and `/file` before
 * the stores merged, and the merge is not a rename: what they gain is a
 * graduation row, which is a row that *ends*. A promoted finding stamped a status
 * and never learned what became of the job it queued; a filed one carried a ticket
 * ref with nothing watching whether the filing agent ever created it.
 */

test('queueing a job for a claim opens work and moves the claim nowhere', async () => {
  const system = build();
  const app = await serve(system);
  // A **proposal**, deliberately: one agent's report is exactly what every finding
  // was, and refusing to act on one would be the regression this merge must not
  // make.
  const filed = system.store.proposeFact(
    {
      claim: 'The retry helper squares the delay instead of doubling it.',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'The 5th retry waits ~17 minutes.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: 'pr:41',
      where: 'src/net/backoff.ts:41',
    },
    { agentId: 'a1', taskId: 't1', goalRef: 'issue:12', sessionId: null, words: 'The 5th retry waits ~17 minutes.' },
  );
  assert.ok(filed.outcome !== 'barred');

  const res = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${filed.fact.id}/exit`,
    payload: { exit: 'job' },
  });
  assert.equal(res.statusCode, 200);
  const { job, graduation } = res.json() as {
    job: { kind: string; prompt: string; originRef: string | null };
    graduation: { exit: string; outcome: string | null; target: string | null };
  };
  // A code job, because it is the work itself.
  assert.equal(job.kind, 'code');
  // The item the claim is *about*, never the goal it was observed on: the graph
  // adopts a job by its origin, so the other answer files the work under somebody
  // else's goal.
  assert.equal(job.originRef, 'pr:41');
  assert.match(job.prompt, /squares the delay/);
  assert.match(job.prompt, /src\/net\/backoff\.ts:41/);
  assert.match(job.prompt, /~17 minutes/);
  assert.match(job.prompt, /Verify it before acting on it/);

  // An open graduation, which is the whole of what a promoted finding did not have:
  // the sweep reads this and says what became of the job.
  assert.equal(graduation.exit, 'job');
  assert.equal(graduation.outcome, null);
  // A job has no document, and a defaulted one would be a target nothing writes into.
  assert.equal(graduation.target, null);
  // And the claim is exactly where it was.
  assert.equal(system.store.getFact(filed.fact.id)?.reach, 'proposal');
  await app.close();
});

test('filing a claim queues a desk job, and the ticket is what lands it', async () => {
  const system = build();
  // A real tracker, because the ticket exit is gated on there being one to file into.
  system.config.integrations.issues = 'github';
  system.config.github = { owner: 'a', repo: 'b' } as never;
  const app = await serve(system);
  const fact = injectedClaim(system);

  const res = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${fact.id}/exit`,
    payload: { exit: 'ticket' },
  });
  assert.equal(res.statusCode, 200);
  const { job } = res.json() as { job: { id: string; kind: string; title: string; prompt: string } };
  // Desk, not code: filing touches no repository, so a worktree and a branch would
  // be cut for a task that never writes a file.
  assert.equal(job.kind, 'desk');
  assert.match(job.title, /^File ticket: /);
  // Rendered from the operator's template book — how a ticket reads is house style.
  assert.match(job.prompt, /link_ticket/);
  assert.match(job.prompt, /never reads the request/);
  // The two placeholders the taxonomy left behind are still filled, because
  // `renderTemplate` leaves an unfilled `{token}` in the prompt verbatim and an
  // override written against the older book still names them.
  assert.doesNotMatch(job.prompt, /\{\w+\}/);

  const graduation = system.store.listGraduations()[0]!;
  assert.equal(graduation.exit, 'ticket');
  assert.equal(graduation.ticketRef, null);
  // Two states because filing is asynchronous: the click queues a job, and the item
  // exists only once the agent has written it. The claim is still delivered until
  // then — collapsing them would take it out of every prompt for a ticket that does
  // not exist yet.
  assert.equal(system.store.getFact(fact.id)?.reach, 'injected');

  // And the sweep is not the thing that ends it: a ticket exit has no pull request
  // to watch, and a sweep reading one anyway would be a second answer to a question
  // `link_ticket` already answers.
  assert.deepEqual(system.store.openGraduations(), []);

  const linked = system.store.linkGraduationTicket(graduation.id, 'issue:314');
  assert.equal(linked?.ticketRef, 'issue:314');
  assert.equal(linked?.outcome, 'landed');
  // The item existing *is* the exit being taken, so the claim leaves every prompt on
  // the same call — one write, because a ticket recorded over a claim still injected
  // pays context for a sentence the backlog now carries.
  assert.equal(system.store.getFact(fact.id)?.reach, 'graduated');
  // Idempotent in the write: an agent that calls `link_ticket` twice links once.
  assert.equal(system.store.linkGraduationTicket(graduation.id, 'issue:999'), null);
  await app.close();
});

test('with no tracker configured there is nothing to file into, and the other exits still work', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);
  const refused = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${fact.id}/exit`,
    payload: { exit: 'ticket' },
  });
  // The same gate all four filing arms ask. The cockpit hides the control, so
  // reaching here means a direct call.
  assert.equal(refused.statusCode, 409);
  assert.match((refused.json() as { error: string }).error, /no issue tracker is configured/);
  assert.deepEqual(system.store.listGraduations(), []);

  const queued = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${fact.id}/exit`,
    payload: { exit: 'job' },
  });
  assert.equal(queued.statusCode, 200);
  await app.close();
});

test('one exit at a time, whichever it is', async () => {
  const system = build();
  const app = await serve(system);
  const fact = injectedClaim(system);
  const send = (exit: string) =>
    app.inject({ method: 'POST', url: `/api/knowledge/facts/${fact.id}/exit`, payload: { exit } });

  assert.equal((await send('job')).statusCode, 200);
  // Two jobs on one claim is two agents on one piece of work, and a documentation
  // pull request opened beside an open job is two chances to land a half of it. The
  // refusal names the exit already going, so the operator knows what to wait for.
  const second = await send('docs');
  assert.equal(second.statusCode, 409);
  assert.match((second.json() as { error: string }).error, /already on its way out by its job exit/);
  assert.equal(system.store.listGraduations().length, 1);
  await app.close();
});

// -- the landing --------------------------------------------------------------

test('a claim reaches graduated when its pull request lands, and not when the job is queued', async () => {
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

test('what may be sent on, by which exit, and the wording of each refusal', () => {
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
  assert.equal(exitableFact(base, 'docs').ok, true);
  assert.equal(exitableFact({ ...base, reach: 'lookup' }, 'docs').ok, true);
  for (const reach of ['proposal', 'graduated', 'rejected', 'superseded'] as const) {
    assert.equal(exitableFact({ ...base, reach }, 'docs').ok, false, `${reach} is committable`);
  }
  const notice = { ...base, lifetime: 'expiring' as const, expiresAt: '2026-09-01T00:00:00.000Z' };
  assert.equal(exitableFact(notice, 'docs').ok, false);

  // The two refusals a `docs` exit makes are the two a `job` or a `ticket` does
  // not, and that asymmetry is why the check takes the exit. `docs` **asserts** the
  // claim in a document that outlives the afternoon; the other two **act on** it,
  // which asserts nothing — and a proposal is exactly what every finding an
  // operator ever clicked "Queue job" on was.
  for (const exit of ['job', 'ticket'] as const) {
    assert.equal(exitableFact({ ...base, reach: 'proposal' }, exit).ok, true, `${exit} refuses a proposal`);
    assert.equal(exitableFact(notice, exit).ok, true, `${exit} refuses a notice`);
    // The terminal reaches are refused by every exit alike: there is nothing left
    // to send anywhere.
    for (const reach of ['graduated', 'rejected', 'superseded', 'retired'] as const) {
      assert.equal(exitableFact({ ...base, reach }, exit).ok, false, `${exit} takes a ${reach} claim`);
    }
  }
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
