import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { FINDING_KIND_HELP, FINDING_KINDS, findingDocsFields, validateFinding } from '../src/mcp/findings.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Agent, Finding } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * The fourth answer to the retrospective's discriminator (#397).
 *
 * Three of its four answers were rails — a lesson to the store, a defect to
 * `report_finding`, a goal-local fact to the pad — and the fourth was prose: a
 * fact about the *code* went into a retrospective read once, by a person, which
 * is the fate #355 opened by objecting to. `docs` is that rail, and everything
 * asserted below is one of the four things that had to stay true while adding it:
 * an agent may not queue work, the gate is the same gate, the claim carries its
 * provenance, and nothing here reaches an agent's context.
 *
 * Where the claim ends is the part worth reading twice. A lesson lives in SQLite
 * because it is *ours*; a repo fact is *theirs*, so the only honest destination
 * is a pull request a human merges — never a push, never a commit the harness
 * makes to a repository it merely operates.
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-docs-'));
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
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** An ordinary working agent, with the credential `report_finding` attributes from. */
function workingAgent(system: System): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Add the hybrid retriever',
    prompt: 'do it',
    branch: 'issue/376',
    originRef: 'issue:376',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/** A docs claim on the books, as `report_finding` would have written it. */
const CLAIM: Finding = {
  id: 'f-docs',
  agentId: 'a1',
  taskId: 't1',
  originRef: 'issue:376',
  kind: 'docs',
  ref: 'issue:376',
  summary: 'A new retriever must be registered in the factory and in the eval harness, or evals skip it',
  where: 'docs/architecture/retrieval.md',
  detail: '`RETRIEVERS` is what production reads; `EVAL_TARGETS` is a second list nothing checks against it.',
  status: 'open',
  jobId: null,
  ticketRef: null,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

// -- the vocabulary -----------------------------------------------------------

test('the kinds and the help map say the same four things', () => {
  assert.deepEqual([...FINDING_KINDS], ['duplicate', 'blocked', 'out_of_scope', 'docs']);
  // The enum, the help map and the derived request have to agree, and only this
  // direction fails silently: a kind missing from the help map is a tool
  // description that quietly omits it, and an agent never learns the kind exists.
  for (const kind of FINDING_KINDS) assert.ok(FINDING_KIND_HELP[kind], `${kind} is described to the agent`);
  assert.equal(Object.keys(FINDING_KIND_HELP).length, FINDING_KINDS.length, 'no help entry names a kind that is gone');
  // And it is offered to agents as a value they may actually send.
  assert.equal(validateFinding({ kind: 'docs', summary: 'The reap writer is registered twice' }).ok, true);
});

// -- the pure half ------------------------------------------------------------

test('the docs prompt carries the claim, its provenance, and ends in a pull request', () => {
  const { title, vars } = findingDocsFields(CLAIM);
  // The job's title, not the document's: what the docs end up saying is the
  // judgement being delegated; this only has to be recognisable in Up next.
  assert.match(title, /^Document: /);

  const prompt = defaultPromptTemplates().render('docs-change', vars);
  assert.match(prompt, /must be registered in the factory and in the eval harness/); // the claim, verbatim
  // `where` and `detail` ride in on the existing `{summary}` value rather than
  // placeholders of their own, so an override that predates them still renders
  // them. → CLAUDE.md, "Prompts and templates".
  assert.match(prompt, /docs\/architecture\/retrieval\.md/);
  assert.match(prompt, /EVAL_TARGETS/);
  assert.match(prompt, /issue:376/); // who learned it, and while doing what
  // The three instructions the route exists to give: check it first, write it
  // where the repository already keeps this, and finish by opening a PR.
  assert.match(prompt, /check it against the code/i);
  assert.match(prompt, /pull request/i);
  assert.match(prompt, /not a direct push/i);
  // A `{token}` reaching an agent is a prompt bug.
  assert.doesNotMatch(prompt, /\{\w+\}/);
});

test('a docs prompt renders without a ref or an origin, because a claim can have neither', () => {
  const orphan = { ...CLAIM, ref: null, originRef: null, where: null, detail: null };
  const prompt = defaultPromptTemplates().render('docs-change', findingDocsFields(orphan).vars);
  assert.doesNotMatch(prompt, /\{\w+\}/);
  assert.doesNotMatch(prompt, /\bnull\b/);
});

// -- the route ----------------------------------------------------------------

test('promoting a docs finding queues a code job carrying the rendered template', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = workingAgent(system);
  const finding = system.store.recordFinding(agent.id, agent.taskId, 'issue:376', {
    kind: 'docs',
    ref: 'issue:376',
    summary: CLAIM.summary,
    where: CLAIM.where,
    detail: CLAIM.detail,
  }).finding;

  const res = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/promote` });
  assert.equal(res.statusCode, 200);
  const job = (res.json() as { job: { id: string; kind: string; title: string; prompt: string } }).job;

  // Code, not desk: it writes files in a tree and pushes a branch to open the
  // pull request from, and a desk job would cut neither.
  assert.equal(job.kind, 'code');
  assert.match(job.title, /^Document: /);
  // And the prompt is the *template's*, not `findingJobRequest`'s derived one —
  // how a documentation change is worded and where it belongs is house style, so
  // it comes from the operator's template book like `finding-ticket` does.
  assert.match(job.prompt, /pull request/i);
  assert.match(job.prompt, /docs\/architecture\/retrieval\.md/);
  assert.doesNotMatch(job.prompt, /promoted a finding .* into work/);

  const after = system.store.getFinding(finding.id)!;
  assert.equal(after.status, 'promoted');
  assert.equal(after.jobId, job.id);
});

test('every other kind keeps the derived prompt, so only docs changed', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = workingAgent(system);
  const finding = system.store.recordFinding(agent.id, agent.taskId, 'issue:376', {
    kind: 'out_of_scope',
    ref: null,
    summary: 'The ingest API buffers a 200MB body before rejecting it',
    where: null,
    detail: null,
  }).finding;

  const res = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/promote` });
  const job = (res.json() as { job: { title: string; prompt: string } }).job;
  assert.match(job.title, /^\[out_of_scope\]/);
  assert.match(job.prompt, /An operator promoted a finding/);
  assert.doesNotMatch(job.prompt, /open a pull request/i);
});

// -- and it is still a claim, not work ----------------------------------------

test('filing a docs finding queues nothing until an operator promotes it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = workingAgent(system);

  const res = await callTool(system, agent, 'report_finding', {
    kind: 'docs',
    summary: 'A new retriever must be registered in the eval harness too, or evals skip it',
    where: 'docs/architecture/retrieval.md',
  });
  assert.equal(res.isError, false);
  // Said in the response and not only in the description: an agent that believes
  // filing scheduled the change stops watching for it.
  assert.match(res.text, /queues no work by itself/);

  const filed = system.store.listFindings().find((f) => f.kind === 'docs')!;
  assert.equal(filed.status, 'open');
  assert.equal(filed.jobId, null);
  // The whole invariant the kind had to be added under: rule `manual-job`
  // dispatches a queued job ahead of every world-driven rule, so an agent that
  // could queue one could put agents on the fleet. Promotion is the only path,
  // and it starts with a click.
  assert.deepEqual(system.store.listJobs(), []);

  // Provenance is structural — from the credential, never from an argument — so
  // the operator can see who learned it and while doing what before vouching.
  assert.equal(filed.originRef, 'issue:376');
  assert.equal(filed.agentId, agent.id);

  // …and the refusal is still available: a claim nobody can refuse is an
  // instruction.
  assert.equal((await app.inject({ method: 'POST', url: `/api/findings/${filed.id}/dismiss` })).statusCode, 200);
  assert.equal(system.store.getFinding(filed.id)!.status, 'dismissed');
  assert.deepEqual(system.store.listJobs(), []);
});

// -- structural ---------------------------------------------------------------

/** Every way a module could reach the findings table. */
const FINDING_STORE_METHODS = [
  'recordFinding',
  'getFinding',
  'listFindings',
  'resolveFinding',
  'findFindingByJobId',
  'linkFindingTicket',
];

test('no dispatch path reads a finding, docs or otherwise', () => {
  // Structural, in the shape `test/lessons.test.ts` uses, and for its reason: the
  // property is "an agent may not queue work", and no behavioural test can see
  // the day someone adds the one rule that consults the claims. A `docs` finding
  // is the newest temptation — it names files, so a rule could plausibly want to
  // read one — and it is refused on the same grounds as the other three.
  //
  // Matched on the store's method names rather than the word "finding":
  // `promptTemplates.ts` legitimately names `report_finding` and `finding-ticket`
  // in prose, which is the dispatcher describing a tool, not a rule consulting
  // the table. The thing that would break the property is a call.
  //
  // `src/dispatcher` and nothing else: unlike a lesson, a finding is *read* on
  // the way out — `src/executor` gathers the goal's findings into the dossier the
  // retrospective is written from. That is a record assembled for a document a
  // person reads, not a decision about what to dispatch, and it is the reason
  // this list is one directory where `test/lessons.test.ts`' is two.
  for (const file of srcFiles('src/dispatcher')) {
    const source = readFileSync(file, 'utf8');
    for (const method of FINDING_STORE_METHODS) {
      assert.equal(source.includes(method), false, `${file} calls ${method}; no dispatch rule may read a finding`);
    }
    assert.equal(/from '.*mcp\/findings\.js'/.test(source), false, `${file} imports the findings module`);
  }
  // …and this proves the search above is looking somewhere real.
  assert.ok(srcFiles('src/dispatcher').length > 5, 'the dispatcher was read');
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
