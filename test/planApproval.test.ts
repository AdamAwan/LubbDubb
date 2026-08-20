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
import { ingestedPlanStatus } from '../src/plans/parts.js';
import { describeProposedParts, planApprovalDetail, planApprovalNote } from '../src/plans/planApproval.js';
import { planApprovalWarnings, planIsWedged, wedgedPlanPrompt } from '../src/plans/planWedge.js';
import { refCollisionReason } from '../src/plans/planReconciler.js';
import { planProposalHold, planProposalRef } from '../src/proposals/proposals.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { PLAN_FILE, parsePlanDocument } from '../src/plans/planDocument.js';
import { Store } from '../src/store/store.js';
import type { DispatchVerdict } from '../src/dispatcher/dispatchCooldown.js';
import type { Agent, Plan, PlanPart, Proposal } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

// -- the pure half -----------------------------------------------------------

test('the gate is the status and nothing else — the part count has no say in it', () => {
  // Off, a plan is `active` the moment it lands. On, it is a proposal instead.
  // Neither reading asks how many parts there are, which is the whole point: a
  // one-part plan is put to the operator on exactly an eight-part plan's terms.
  assert.equal(ingestedPlanStatus(), 'active');
  assert.equal(ingestedPlanStatus(false), 'active');
  assert.equal(ingestedPlanStatus(true), 'awaiting_approval');
});

test('the ask says what each answer does, in one paragraph for every plan', () => {
  // Appended, not templated: an override that never learned a `{settlement}`
  // token would drop it on exactly the deployments that customised most.
  assert.match(planApprovalNote(), /bottom of the stack first/);
  assert.match(planApprovalNote(), /goes back to a planner with your reason/);
  // And it never forks on size — there is no second paragraph to be handed the
  // wrong one of.
  assert.doesNotMatch(planApprovalNote(), /single pull request/);
});

test('the ask leads with what the plan does, and falls back to the shape justification', () => {
  // The two fields an approver is actually deciding on, labelled and in this
  // order: what is wrong, then what is going to be done about it. The split is
  // not here — it is drawn in the plan panel the card's own button opens.
  const full = planApprovalDetail({
    diagnosis: 'The signer is cached at module load.',
    approach: 'Resolve it per request instead.',
    reason: 'Two seams, two reviews.',
  });
  assert.match(String(full), /What's wrong[\s\S]*cached at module load/);
  assert.match(String(full), /What we'll do[\s\S]*per request/);
  assert.doesNotMatch(String(full), /Two seams/, 'why *this shape* is the template’s job, not the body’s');
  // A plan from before those fields existed still has a body rather than a
  // headline and nothing else.
  assert.equal(
    planApprovalDetail({ diagnosis: null, approach: null, reason: 'Two seams, two reviews.' }),
    'Two seams, two reviews.',
  );
  // Said nothing at all: an absent block, not an empty labelled one.
  assert.equal(planApprovalDetail({ diagnosis: null, approach: null, reason: null }), null);
  assert.equal(planApprovalDetail({ diagnosis: '  ', approach: '', reason: ' ' }), null);
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
  const route = (status: Plan['status'], existingParts = 1): string =>
    resolvePlanRoute({
      plan: { ...planRow(), status },
      verdict: { kind: 'dispatch' } as DispatchVerdict,
      existingParts,
    }).route;
  assert.equal(route('awaiting_approval'), 'awaiting_approval');
  // The arms either side of it are untouched.
  assert.equal(route('active'), 'parts');
  assert.equal(route('planning'), 'planning');
  // A plan with one part is on the same arm as a plan with eight: the route does
  // not count them. `unplanned` is reachable only with no plan at all, below.
  assert.equal(route('active', 1), 'parts');
  assert.equal(route('active', 8), 'parts');
});

test('the only arm rule `issue-pickup` still works is the funnel failing open', () => {
  const route = (plan: Plan | null, verdict: DispatchVerdict['kind'], existingParts = 0): string =>
    resolvePlanRoute({ plan, verdict: { kind: verdict, attempts: 3 } as DispatchVerdict, existingParts }).route;
  // No plan and the cap spent: worked whole on the flat branch rather than parked.
  assert.equal(route(null, 'escalate'), 'unplanned');
  assert.equal(route(null, 'hold'), 'unplanned');
  // A replan that gave up keeps the plan it already had — `unplanned` would point
  // pickup at a flat branch git cannot cut beside the existing part refs.
  assert.equal(route({ ...planRow(), status: 'planning' }, 'escalate', 2), 'parts');
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
  const refused = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(refused.status, 'planning', 'the phase-3 route out still fires — back to a planner');

  system.connector.inject({ kind: 'new_pr', number: 5, title: 'One PR', branch: 'issue/12' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 5, author: 'reviewer', body: 'a thought' });
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listProposals().length,
    1,
    'a plan is proposed once per verdict — the world moving is not a new verdict',
  );
  const still = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(still.status, 'planning');
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
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      planning: { requireApproval: true } as never,
      heartbeatIntervalMs: 999_999,
    }),
    { backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  const doc = {
    version: 1,
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
  assert.match(esc.prompt, /2 part\(s\) of work/);
  // The settlement paragraph is appended rather than templated, so an override
  // cannot drop what approving and rejecting actually do.
  assert.match(esc.prompt, /bottom of the stack first/);
  // What the plan *does* rides in `detail`, labelled, where the card draws it as
  // its own block above the buttons — and the split is not in the ask at all: it
  // is a diagram in the plan panel, one click away, and the question here is
  // whether the work is right rather than how it is cut up.
  assert.match(String(esc.context.detail), /two writers disagree/);
  assert.match(String(esc.context.detail), /non-null with a backfill/);
  assert.equal(esc.context.detailFrom, 'What the plan says');
  assert.doesNotMatch(esc.prompt, /"schema"/);

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
  // rule `plan-approval`, which is the whole reason the gate is a typed status and not a timer.
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
  // The route out is a planner, and it is the *same* route out whatever the plan's
  // size. Rejecting used to collapse a plan with parts to the no-parts "single"
  // shape and pick the issue up whole, while rejecting a plan that was already
  // that shape sent it back to a planner — one button meaning two unrelated things
  // depending on a number it did not mention.
  assert.equal(plan.status, 'planning');
  assert.match(plan.reason!, /Schema first\./, "the planner's own reasoning is what is being amended");
  assert.match(plan.reason!, /one PR is fine/);
  assert.deepEqual(
    system.store.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
    'parts nothing started are retired, so the graph says what happened',
  );
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`)!;
  assert.match(audited.detail, /sent the plan for issue:12 back to a planner/);

  // And it *moves*: the next pulse puts a planner back on it rather than leaving
  // the issue with no route at all.
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listTasks().map((t) => t.originRef),
    ['issue:12:plan'],
  );
  system.store.close();
});

test('with approval off, a one-part plan schedules its part and proposes nothing', async () => {
  const { system } = plannedSystem({ requireApproval: false, slugs: ['whole'] });
  const ingested = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(ingested.status, 'active');
  await system.harness.runCycle('manual');

  // The part, on the part branch, through rule `plan-part` — not the issue on the
  // flat branch through rule `issue-pickup`. That second path was what "one pull
  // request" used to mean, and it is the whole difference this removes.
  assert.deepEqual(
    system.store.listTasks().map((t) => [t.originRef, t.branch]),
    [['issue:12:part:whole', 'issue/12/whole']],
    'the flag off is the pre-gate path: the plan commits the moment the planner writes it',
  );
  assert.deepEqual(system.store.listProposals(), [], 'no gate means no rows');
  assert.deepEqual(system.store.listOpenEscalations(), []);
  system.store.close();
});

test('with approval on, a one-part plan is put to the operator like any other', async () => {
  const { system } = plannedSystem({ slugs: ['whole'] });
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');
  await system.harness.runCycle('manual');

  const [proposal, ...rest] = system.store.listProposals();
  assert.equal(rest.length, 0, 'exactly one proposal per plan, whatever its size');
  assert.equal(proposal!.kind, 'plan');
  assert.equal(proposal!.ref, 'issue:12:plan');
  // The same ask, counted in parts, with the same settlement paragraph an
  // eight-part plan gets. There is no second wording for this size.
  const esc = system.store.getEscalation(proposal!.escalationId!)!;
  assert.match(esc.prompt, /1 part/);
  assert.match(esc.prompt, /Reject and the plan goes back to a planner/);
  assert.doesNotMatch(esc.prompt, /single pull request/);
  assert.equal(system.store.listTasks().length, 0, 'nothing is worked before the acceptance step');

  // Repeated pulses neither re-ask nor start anything.
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1);
  assert.equal(system.store.listTasks().length, 0);
  system.store.close();
});

test('accepting a one-part plan releases it, and its part is dispatched like any other', async () => {
  const { system } = plannedSystem({ slugs: ['whole'] });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const accepted = await system.proposals.accept(proposal.id, 'one PR is right');
  assert.equal(accepted!.outcome, 'performed');
  const released = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(released.status, 'active');
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`)!;
  assert.match(audited.detail, /released the 1-part plan for issue:12/);
  assert.match(audited.detail, /authorized by you/);

  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listTasks().map((t) => [t.originRef, t.branch]),
    [['issue:12:part:whole', 'issue/12/whole']],
  );
  system.store.close();
});

test('rejecting a one-part plan sends it back to a planner with the reason, not into a wall', async () => {
  const { system } = plannedSystem({ slugs: ['whole'] });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  system.proposals.reject(proposal.id, 'the migration has to land on its own');
  const plan = system.store.getPlanByOrigin('issue:12')!;
  // A replan is the only answer with a decision left in it — the same status write
  // `POST /api/plans/:id/replan` makes.
  assert.equal(plan.status, 'planning');
  assert.match(plan.reason!, /Schema first\./, "the planner's own reasoning is what is being amended");
  assert.match(plan.reason!, /the migration has to land on its own/);
  assert.equal(system.store.listTasks().length, 0, 'and nothing was picked up on the way past');

  // And it *moves*: the next pulse puts a planner back on it rather than leaving
  // the issue with no route.
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listTasks().map((t) => t.originRef),
    ['issue:12:plan'],
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
  // Withdrawn, not left pending: a pending verdict holds rule `plan-approval` off the plan, so
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
    touches: [],
    size: null,
    acceptanceMet: [],
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

/** An issue that has already been planned — into two independent parts, or as one PR. */
function plannedSystem(opts: { requireApproval?: boolean; slugs?: string[] } = {}): {
  system: System;
  repoRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const repoRoot = gitRepo();
  const config = loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot,
    planning: { requireApproval: opts.requireApproval ?? true } as never,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Big thing', body: 'Several PRs.' });
  submitPlan(system, 'issue:12', opts.slugs ?? ['schema', 'api']);
  return { system, repoRoot };
}

/** Land a planner's plan the way both transports do — through the one ingestion. */
function submitPlan(system: System, originRef: string, slugs: string[]): void {
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Schema first.',
      diagnosis: 'The column is nullable and two writers disagree about it.',
      approach: 'Make it non-null with a backfill, then teach both writers the one shape.',
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

// -- the wedge: a plan approved onto a branch its parts cannot sit beneath -----

test('planIsWedged needs every live part blocked, and ignores retired ones', () => {
  const blocked = (slug: string, seq: number): PlanPart => ({
    ...partRow(slug, seq),
    status: 'blocked',
    blockedReason: refCollisionReason(12, { local: true, remote: false }),
  });
  assert.equal(planIsWedged([blocked('a', 1), blocked('b', 2)]), true);
  // One part still moving is a plan still making progress. The collision blocks
  // every part together or none, so a mixture is never the wedge.
  assert.equal(planIsWedged([blocked('a', 1), partRow('b', 2)]), false);
  assert.equal(planIsWedged([{ ...partRow('a', 1), status: 'retired' }, blocked('b', 2)]), true);
  // Empty is not wedged but empty — a different thing, left to say so itself.
  assert.equal(planIsWedged([]), false);
  assert.equal(planIsWedged([{ ...partRow('a', 1), status: 'retired' }]), false);
});

test('the approval ask names an open PR that would belong to no part', () => {
  const issue = {
    id: 'i12',
    number: 12,
    title: 'Big thing',
    body: '',
    labels: [],
    state: 'open' as const,
    linkedPrNumber: 31231,
  };
  const pr = {
    id: 'pr31231',
    number: 31231,
    title: 'Fix the thing',
    branch: 'issue/12',
    ciStatus: 'passing' as const,
    unresolvedComments: [],
  };
  const parts = [partRow('a', 1), partRow('b', 2)];

  const warning = planApprovalWarnings(issue, parts, [pr]);
  assert.match(warning, /PR #31231/);
  assert.match(warning, /belongs to no part/);
  // It says what approving does *not* do, because nothing here knows which part
  // the PR satisfies — naming it is the whole contribution.
  assert.match(warning, /does not close it, hand it to a part/);

  // A part that has claimed the PR is the ordinary working plan: nothing to say.
  assert.equal(planApprovalWarnings(issue, [{ ...parts[0]!, prNumber: 31231 }, parts[1]!], [pr]), '');
  // And a plan with nothing open against its issue warns about nothing at all,
  // so nothing is appended to the ask.
  assert.equal(planApprovalWarnings({ ...issue, linkedPrNumber: null }, parts, []), '');
});

test('a blocked decomposition warns before it is approved, quoting the stored reason', () => {
  const issue = {
    id: 'i12',
    number: 12,
    title: 'Big thing',
    body: '',
    labels: [],
    state: 'open' as const,
    linkedPrNumber: null,
  };
  const parts = [
    {
      ...partRow('a', 1),
      status: 'blocked' as const,
      blockedReason: refCollisionReason(12, { local: true, remote: false }),
    },
  ];
  const warning = planApprovalWarnings(issue, parts, []);
  // Quoted off the row rather than recomposed, so the ask, the plate and the
  // Errors panel are one sentence.
  assert.ok(warning.includes(refCollisionReason(12, { local: true, remote: false })));
  assert.match(warning, /cannot be cut/);
});

test('the wedge escalation names the PR holding the branch', () => {
  // Approval was days ago, so `planApprovalWarnings` having said it once is not
  // the same as saying it at the moment the operator is stuck on it.
  const issue = {
    id: 'i12',
    number: 12,
    title: 'Big thing',
    body: '',
    labels: [],
    state: 'open' as const,
    linkedPrNumber: null,
  };
  const pr = {
    id: 'pr31783',
    number: 31783,
    title: 'Fix the thing',
    branch: 'issue/12',
    ciStatus: 'passing' as const,
    unresolvedComments: [],
  };
  const reason = refCollisionReason(12, { local: false, remote: true });
  const parts = [
    { ...partRow('a', 1), status: 'blocked' as const, blockedReason: reason },
    { ...partRow('b', 2), status: 'blocked' as const, blockedReason: reason },
  ];

  const prompt = wedgedPlanPrompt(12, issue, parts, [pr]);
  assert.ok(prompt.includes(reason), 'the stored reason verbatim, not a second rendering');
  assert.match(prompt, /PR #31783 \("Fix the thing"\) is open on issue\/12/);
  assert.match(prompt, /merged or abandoned/);
  // Still refused: nothing claims the PR for a part.
  assert.match(prompt, /nothing here knows which part, if any, it satisfies/);

  // A plan with nothing unclaimed open against its issue says nothing about a PR.
  assert.doesNotMatch(wedgedPlanPrompt(12, issue, parts, []), /PR #/);
  assert.doesNotMatch(wedgedPlanPrompt(12, issue, [{ ...parts[0]!, prNumber: 31783 }, parts[1]!], [pr]), /PR #/);
});

test('the way out of a wedged plan is a replan, and the ask says so', async () => {
  // There is no `abandon` any more, and the reason is the point: abandoning meant
  // "retire the parts and work the issue as one pull request", which was only a
  // distinct act while a plan with no parts was a *different kind of plan*. It is
  // not one now, so the operator's exit is the one every wrong plan has — Replan.
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  await system.proposals.accept(system.store.listProposals()[0]!.id);
  const plan = system.store.getPlanByOrigin('issue:12')!;

  const { app } = await buildApp(system);
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/abandon` })).statusCode,
    404,
    'the route is gone, not merely unused',
  );
  assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` })).statusCode, 200);
  assert.equal(system.store.getPlan(plan.id)!.status, 'planning');
  await app.close();
  system.store.close();
});
