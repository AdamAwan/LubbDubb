import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { DEFAULT_PLANNING, resolvePlanRoute } from '../src/plans/planning.js';
import { amendedPlanStatus } from '../src/plans/parts.js';
import { describeProposedParts } from '../src/plans/planApproval.js';
import { planProposalHold, planProposalRef } from '../src/proposals/proposals.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { PLAN_FILE, parsePlanDocument } from '../src/plans/planDocument.js';
import { Store } from '../src/store/store.js';
import type { DispatchVerdict } from '../src/dispatcher/dispatchCooldown.js';
import type { Agent, Plan, PlanPart, Proposal } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

// -- the pure half -----------------------------------------------------------

test('requireApproval only changes where a parts verdict lands', () => {
  // Off (the default) is byte-for-byte what it was: a decomposition is work.
  assert.equal(amendedPlanStatus('parts', []), 'active');
  assert.equal(amendedPlanStatus('parts', [], false), 'active');
  // On, it is a proposal instead. The status *is* the gate.
  assert.equal(amendedPlanStatus('parts', [], true), 'awaiting_approval');
  // A `single` verdict is never gated: it proposes nothing, and gating it would
  // park an issue on a question with no decision in it.
  assert.equal(amendedPlanStatus('single', [], true), 'single');
});

test('approval is on by default, in both places that default it', () => {
  // Two sites default this and they must agree: the config loader is what a
  // deployment gets, `DEFAULT_PLANNING` is what a `RuleDispatcher` constructed
  // without one gets. A drift between them is a gate that is on for the harness
  // and off for the dispatcher, which reads as "the rule never fires".
  assert.equal(DEFAULT_PLANNING.requireApproval, true);
  assert.equal(loadConfig().planning.requireApproval, true);
  // Off is still reachable and still means what it meant.
  assert.equal(loadConfig({ planning: { requireApproval: false } as never }).planning.requireApproval, false);
});

test('the funnel names the awaiting arm, so the chip and the rules read one verdict', () => {
  const route = (status: Plan['status']): string =>
    resolvePlanRoute({
      planning: { ...DEFAULT_PLANNING, enabled: true },
      plan: { ...planRow(), status },
      verdict: { kind: 'dispatch' } as DispatchVerdict,
    }).route;
  assert.equal(route('awaiting_approval'), 'awaiting_approval');
  // The arms either side of it are untouched.
  assert.equal(route('active'), 'parts');
  assert.equal(route('single'), 'single');
  assert.equal(route('planning'), 'planning');
});

test('a plan proposal is held by a pending verdict only — not by a settled one', () => {
  const ref = planProposalRef('issue:12');
  const at = (status: Proposal['status']): Proposal[] => [
    { ...proposalRow(), kind: 'plan', ref, status, decidedAt: '2026-07-25T00:00:00.000Z' },
  ];
  assert.match(planProposalHold(ref, at('pending'))!, /awaiting your accept\/reject/);
  // Neither settled arm holds, and each for its own reason. `rejected` must not:
  // the refusal already moved the plan out of `awaiting_approval`, so only a
  // replan the operator asked for can bring the question back — and refusing to
  // ask again would make one "no" veto every future decomposition.
  assert.equal(planProposalHold(ref, at('rejected')), null);
  // `accepted` must not either: release is the plan's own one-way transition, so
  // a hold here would be a settle window that could expire — re-proposing an
  // approved decomposition to an operator whose agents are already working it.
  assert.equal(planProposalHold(ref, at('accepted')), null);
  // Another issue's verdict is not this one's.
  assert.equal(planProposalHold(planProposalRef('issue:99'), at('pending')), null);
});

test('phase 4 stops at the plan predicate: a plan verdict has no signal expiry to inherit', async () => {
  // The two predicates are separate on purpose, and the polarity is the reason.
  // `proposalHold` holds a rejection until the world item moves; `planProposalHold`
  // never holds one at all, so there is no hold for a signal to end — and the
  // signature says so: it takes no signals, because a transition on `issue:<n>`
  // says nothing about whether a decomposition is the right shape.
  const ref = planProposalRef('issue:12');
  const rejected: Proposal[] = [
    { ...proposalRow(), ref, status: 'rejected', note: 'one PR is fine', decidedAt: '2026-07-25T00:00:00.000Z' },
  ];
  assert.equal(planProposalHold(ref, rejected), null);

  // End to end, with the world moving under a refused decomposition: the route
  // out of phase 3 still fires, and no world event re-opens the question.
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;
  system.proposals.reject(proposal.id, 'one PR is fine');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'single', 'the phase-3 route out still fires');

  system.connector.inject({ kind: 'new_pr', number: 5, title: 'One PR', branch: 'issue/12' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 5, author: 'reviewer', body: 'a thought' });
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listProposals().length,
    1,
    'a plan is proposed once per verdict — the world moving is not a new verdict',
  );
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'single');
  system.store.close();
});

test('the ask carries the shape of the split, not just a count', () => {
  const rendered = describeProposedParts([
    partRow('schema', 1),
    { ...partRow('reader', 2), dependsOn: ['schema'] },
    { ...partRow('dropped', 3), status: 'retired' },
  ]);
  assert.match(rendered, /"schema": The schema part — src\/schema\//);
  assert.match(rendered, /"reader": .*stacks on "schema"/);
  assert.doesNotMatch(rendered, /dropped/, 'a retired part is not part of the proposal');
});

// -- ingestion ---------------------------------------------------------------

test('ingestion persists a parts verdict as work by default and as a proposal when asked', () => {
  const store = new Store(':memory:');
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'Schema first.',
      parts: [{ slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] }],
    }),
  );
  assert.ok(doc.ok);

  const off = ingestPlanDocument(store, { doc: doc.document, originRef: 'issue:12', title: 'Big thing' });
  assert.equal(off.status, 'active');

  const on = ingestPlanDocument(store, {
    doc: doc.document,
    originRef: 'issue:13',
    title: 'Other thing',
    requireApproval: true,
  });
  assert.equal(on.status, 'awaiting_approval');
  // Both wrote their parts: the gate holds scheduling, not the record of the verdict.
  assert.equal(store.listPlanParts(on.plan.id).length, 1);
  store.close();
});

test('both transports honour the gate, so a verdict lands the same way whichever carried it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const system = buildSystem(
    loadConfig({
      // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      dispatcher: 'rule',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      planning: { enabled: true, requireApproval: true } as never,
      heartbeatIntervalMs: 999_999,
    }),
    { backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  const doc = {
    version: 1,
    verdict: 'parts',
    reason: 'Schema first.',
    parts: [{ slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] }],
  };

  // The `plan.json` side channel, through the file-events drain.
  const filePlanner = plannerAgent(system, 'issue:12:plan');
  const target = join(filePlanner.cwd, PLAN_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(doc));
  writeFileSync(join(system.agents.fileEventsDir(filePlanner.id)!, '1-a.json'), JSON.stringify({ path: target }));
  system.agents.drainFileEvents(filePlanner.id);
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');

  // The `plan_submit` tool, which can additionally say so to the planner — the
  // whole reason the typed channel exists. A planner that thought its parts were
  // being worked would otherwise wait on siblings that never start.
  const toolPlanner = plannerAgent(system, 'issue:13:plan');
  const result = await system.mcp.session(toolPlanner.id)!.call('plan_submit', doc);
  const text = (result as { content: { text?: string }[] }).content[0]?.text ?? '';
  assert.equal(system.store.getPlanByOrigin('issue:13')!.status, 'awaiting_approval');
  assert.match(text, /nothing is scheduled until an operator approves it/);
  system.store.close();
});

// -- end to end --------------------------------------------------------------

test('with approval off, a parts verdict schedules exactly as it did, and proposes nothing', async () => {
  const { system } = plannedSystem({ requireApproval: false });
  await system.harness.runCycle('manual');

  const parts = system.store.listPlanParts(system.store.getPlanByOrigin('issue:12')!.id);
  assert.deepEqual(
    parts.map((p) => p.status),
    ['dispatched', 'dispatched'],
    'the default path commits the decomposition the moment the planner writes it',
  );
  assert.deepEqual(system.store.listProposals(), [], 'no gate means no rows');
  assert.deepEqual(system.store.listOpenEscalations(), []);
  system.store.close();
});

test('with approval on, the verdict lands, one proposal is pending, and nothing is dispatched', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');

  const plan = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(plan.status, 'awaiting_approval');
  const [proposal, ...rest] = system.store.listProposals();
  assert.equal(rest.length, 0, 'exactly one proposal per verdict');
  assert.equal(proposal!.kind, 'plan');
  assert.equal(proposal!.ref, 'issue:12:plan');
  assert.equal(proposal!.status, 'pending');
  // It hangs off an inbox item, like every other proposal — "Needs you" is where
  // a decision is answered, and the escalation stays the routing mechanism.
  const esc = system.store.getEscalation(proposal!.escalationId!)!;
  assert.equal(esc.type, 'approve_change');
  assert.match(esc.prompt, /2 stacked pull request/);
  assert.match(esc.prompt, /"schema"/);

  const parts = system.store.listPlanParts(plan.id);
  assert.deepEqual(
    parts.map((p) => p.status),
    ['ready', 'ready'],
    'reconciliation still runs — the parts are ready, they are just not released',
  );
  assert.equal(system.store.listTasks().length, 0, 'no agent commits to a stack nobody approved');

  // The hold is visible rather than silent: both parts are queued as `unapproved`.
  assert.deepEqual(
    (system.harness.upcoming?.items ?? []).map((q) => [q.origin, q.status]),
    [
      ['issue:12:part:schema', 'unapproved'],
      ['issue:12:part:api', 'unapproved'],
    ],
  );

  // Repeated pulses neither re-ask nor grow rows: the pending verdict holds
  // rule 3d, which is the whole reason the gate is a typed status and not a timer.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1);
  assert.equal(system.store.listOpenEscalations().length, 1);
  assert.equal(system.store.listTasks().length, 0);
  system.store.close();
});

test('accepting releases the plan, and the parts schedule once, audited to the human', async () => {
  const { system, repoRoot } = plannedSystem();
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const accepted = await system.proposals.accept(proposal.id, 'good split');
  assert.equal(accepted!.outcome, 'performed');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'active');
  // The inbox empties on the click, exactly as it does for a merge.
  assert.equal(system.store.getEscalation(proposal.escalationId!)!.status, 'answered');
  // Audited the way phase 2's authority chain attributes any accepted proposal:
  // outside the pulse, under `human:<id>`, naming who authorized it.
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`)!;
  assert.match(audited.detail, /Approved the plan: released the 2-part plan for issue:12/);
  assert.match(audited.detail, /authorized by you/);

  await system.harness.runCycle('manual');
  const parts = system.store.listPlanParts(system.store.getPlanByOrigin('issue:12')!.id);
  assert.deepEqual(
    parts.map((p) => [p.slug, p.status]),
    [
      ['schema', 'dispatched'],
      ['api', 'dispatched'],
    ],
  );
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(branches, /issue\/12\/schema/);

  // Once. A second accept changes nothing, and another pulse starts no second agent.
  assert.equal(await system.proposals.accept(proposal.id), null);
  await system.harness.runCycle('manual');
  assert.equal(system.store.listTasks().length, 2);
  system.store.close();
});

test('rejecting schedules nothing and leaves the issue a route rather than parking it', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const rejected = system.proposals.reject(proposal.id, 'one PR is fine');
  assert.equal(rejected!.outcome, 'none');
  const plan = system.store.getPlanByOrigin('issue:12')!;
  // The route out: nothing was started, so the issue falls back to the single-PR
  // path the funnel already fails open to — not to a status nothing schedules.
  assert.equal(plan.status, 'single');
  assert.deepEqual(
    system.store.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
    'parts nothing started are retired, so the graph says what happened',
  );
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`)!;
  assert.match(audited.detail, /falls back to a single pull request/);

  // And it *moves*: the next pulse picks the issue up as one PR, on `issue/12`.
  await system.harness.runCycle('manual');
  const tasks = system.store.listTasks();
  assert.deepEqual(
    tasks.map((t) => [t.originRef, t.branch]),
    [['issue:12', 'issue/12']],
  );
  system.store.close();
});

test('a replan asks again, and the superseded verdict can neither release nor gag the new one', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  const first = system.store.listProposals()[0]!;
  await system.proposals.accept(first.id);
  await system.harness.runCycle('manual'); // parts dispatch

  const plan = system.store.getPlanByOrigin('issue:12')!;
  const { app } = await buildApp(system);
  assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` })).statusCode, 200);
  assert.equal(system.store.getPlan(plan.id)!.status, 'planning');

  // The amended verdict is a new proposal, not the old one: the accepted row is
  // settled and one-way, and release is the plan's status, which the replan reset.
  submitPlan(system, 'issue:12', ['schema', 'api', 'docs']);
  await system.harness.runCycle('manual');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');
  const proposals = system.store.listProposals();
  assert.equal(proposals.length, 2, 'the replan is asked about on its own terms');
  assert.equal(proposals[0]!.status, 'pending');
  assert.equal(proposals[1]!.id, first.id);
  assert.equal(system.store.getProposal(first.id)!.status, 'accepted');
  // The new part is not dispatched off the old approval.
  const docs = system.store.listPlanParts(plan.id).find((p) => p.slug === 'docs')!;
  assert.equal(docs.status, 'ready');
  await app.close();
  system.store.close();
});

test('a replan withdraws the question it supersedes, so the amended plan is still askable', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  const first = system.store.listProposals()[0]!;
  const plan = system.store.getPlanByOrigin('issue:12')!;

  const { app } = await buildApp(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  // Withdrawn, not left pending: a pending verdict holds rule 3d off the plan, so
  // the amended decomposition would never be put to anyone — and the stale card,
  // if accepted, would release a plan its reader never saw.
  const withdrawn = system.store.getProposal(first.id)!;
  assert.equal(withdrawn.status, 'rejected');
  assert.equal(withdrawn.note, 'superseded by a replan');
  // The withdrawal is only the question closing: the plan is mid-replan, so
  // `refusePlan` finds nothing to settle and no part is retired.
  assert.equal(system.store.getPlan(plan.id)!.status, 'planning');
  assert.deepEqual(
    system.store.listPlanParts(plan.id).map((p) => p.status),
    ['ready', 'ready'],
  );

  submitPlan(system, 'issue:12', ['schema', 'api']);
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().filter((p) => p.status === 'pending').length, 1);
  await app.close();
  system.store.close();
});

test('free text cannot settle a decomposition', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: `/api/escalations/${proposal.escalationId}/answer`,
    payload: { response: 'sure, go ahead' },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, new RegExp(`/api/proposals/${proposal.id}/accept`));
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');
  await app.close();
  system.store.close();
});

// -- fixtures ----------------------------------------------------------------

function planRow(): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'awaiting_approval',
    reason: 'Schema must land first.',
    risks: null,
    outOfScope: null,
    document: null,
    discussing: false,
    statusCommentRef: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function partRow(slug: string, seq: number): PlanPart {
  return {
    id: `plan_1:${slug}`,
    planId: 'plan_1',
    slug,
    seq,
    title: `The ${slug} part`,
    scope: `src/${slug}/`,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    rationale: null,
    acceptance: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    taskId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function proposalRow(): Proposal {
  return {
    id: 'prop_1',
    kind: 'plan',
    ref: 'issue:12:plan',
    status: 'pending',
    action: { type: 'propose_plan', reason: 'x' },
    note: null,
    decidedBy: null,
    decidedAt: null,
    escalationId: 'esc_1',
    createdAt: '2026-07-25T00:00:00.000Z',
  };
}

/** A planning agent with a real cwd — enough for the file drain, no worktree needed. */
function plannerAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Plan it',
    prompt: 'plan it',
    branch: 'plan/issue/12',
    originRef,
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

/** An issue that has already been planned into two independent parts. */
function plannedSystem(opts: { requireApproval?: boolean } = {}): { system: System; repoRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const repoRoot = gitRepo();
  const config = loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot,
    planning: { enabled: true, requireApproval: opts.requireApproval ?? true } as never,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Big thing', body: 'Several PRs.' });
  submitPlan(system, 'issue:12', ['schema', 'api']);
  return { system, repoRoot };
}

/** Land a planner's verdict the way both transports do — through the one ingestion. */
function submitPlan(system: System, originRef: string, slugs: string[]): void {
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'Schema first.',
      parts: slugs.map((slug) => ({ slug, title: slug, scope: `src/${slug}/`, dependsOn: [] })),
    }),
  );
  assert.ok(doc.ok);
  ingestPlanDocument(system.store, {
    doc: doc.document,
    originRef,
    title: 'Big thing',
    requireApproval: system.config.planning.requireApproval,
  });
}
