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
import { amendedPlanStatus, planShape } from '../src/plans/parts.js';
import {
  abandonDecomposition,
  describeProposedParts,
  describeSingleRoute,
  planApprovalDetail,
  planApprovalNote,
} from '../src/plans/planApproval.js';
import { planApprovalWarnings, planIsWedged } from '../src/plans/planWedge.js';
import { refCollisionReason } from '../src/plans/planReconciler.js';
import { planProposalHold, planProposalRef } from '../src/proposals/proposals.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { PLAN_FILE, parsePlanDocument } from '../src/plans/planDocument.js';
import { Store } from '../src/store/store.js';
import type { DispatchVerdict } from '../src/dispatcher/dispatchCooldown.js';
import type { Agent, Plan, PlanPart, Proposal } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

// -- the pure half -----------------------------------------------------------

test('requireApproval gates both arms, and off is byte-for-byte what it was', () => {
  // Off, both arms are `active` — the status is the plan's life, and which shape
  // it is being delivered in is the parts (`planShape`), not a second status.
  assert.equal(amendedPlanStatus('parts', []), 'active');
  assert.equal(amendedPlanStatus('parts', [], false), 'active');
  assert.equal(amendedPlanStatus('single', []), 'active');
  assert.equal(amendedPlanStatus('single', [], false), 'active');
  // On, each is a proposal instead. The status *is* the gate, for both.
  assert.equal(amendedPlanStatus('parts', [], true), 'awaiting_approval');
  assert.equal(amendedPlanStatus('single', [], true), 'awaiting_approval');
  // Except the one `single` arm that is not a verdict but an override: parts are
  // already in flight, so the collapse was refused and there is no decision in it.
  const inFlight = [{ ...partRow('a', 1), status: 'in_review' as const, prNumber: 7 }];
  assert.equal(amendedPlanStatus('single', inFlight, true), 'active');
  assert.equal(amendedPlanStatus('single', inFlight, false), 'active');
});

test('the shape is the parts, and a retired row is not one', () => {
  assert.equal(planShape([partRow('a', 1)]), 'parts');
  // No live parts *is* the single arm — the one reading rule `issue-pickup`, the
  // reconciler and the conclusion resolver all take, so none of them can hold a
  // different opinion about a plan than the others.
  assert.equal(planShape([]), 'single');
  // Retired rows are not parts, so an abandoned decomposition is the same single
  // arm as a plan that never declared any.
  assert.equal(planShape([{ ...partRow('a', 1), status: 'retired' }]), 'single');
});

test('the single arm of the ask carries a shape too, and says what each answer does', () => {
  // The branch is named because a branch that already exists is exactly what the
  // other warnings on this ask are about.
  assert.match(describeSingleRoute(12), /branch issue\/12/);
  assert.match(describeSingleRoute(12), /single pull request/);
  // Appended, not templated — the two arms settle differently enough that a reader
  // given the wrong paragraph would answer the wrong question.
  assert.match(planApprovalNote(12, true), /Reject and the plan goes back to a planner/);
  assert.match(planApprovalNote(12, false), /bottom of the stack first/);
  assert.match(planApprovalNote(12, false), /worked as a single pull request instead/);
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
  // And the single arm is the same `active` row with no live parts — the shape,
  // read off the graph rather than off a status that could only be one or the other.
  assert.equal(route('active', 0), 'single');
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
  assert.equal(refused.status, 'active', 'the phase-3 route out still fires');
  assert.equal(planShape(system.store.listPlanParts(refused.id)), 'single', 'and it falls back to one PR');

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
  assert.equal(still.status, 'active');
  assert.equal(planShape(system.store.listPlanParts(still.id)), 'single');
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
  assert.match(esc.prompt, /2 pull request/);
  // The arm's own paragraph is appended, so an override that never learned about
  // the single arm cannot leave a reader guessing which question this is.
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
  // The route out: nothing was started, so the issue falls back to the single-PR
  // path the funnel already fails open to. `active` with every part retired *is*
  // that shape — the status is the plan's life, the parts are its shape.
  assert.equal(plan.status, 'active');
  assert.equal(planShape(system.store.listPlanParts(plan.id)), 'single');
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

test('with approval off, a single verdict is picked up exactly as it was, and proposes nothing', async () => {
  const { system } = plannedSystem({ requireApproval: false, verdict: 'single' });
  const ingested = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(ingested.status, 'active');
  assert.equal(planShape(system.store.listPlanParts(ingested.id)), 'single');
  await system.harness.runCycle('manual');

  assert.deepEqual(
    system.store.listTasks().map((t) => [t.originRef, t.branch]),
    [['issue:12', 'issue/12']],
    'the flag off is the pre-gate path: the verdict commits the moment the planner writes it',
  );
  assert.deepEqual(system.store.listProposals(), [], 'no gate means no rows');
  assert.deepEqual(system.store.listOpenEscalations(), []);
  system.store.close();
});

test('with approval on, a single verdict is put to the operator and picks nothing up', async () => {
  const { system } = plannedSystem({ verdict: 'single' });
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');
  await system.harness.runCycle('manual');

  const [proposal, ...rest] = system.store.listProposals();
  assert.equal(rest.length, 0, 'exactly one proposal per verdict, on this arm too');
  assert.equal(proposal!.kind, 'plan');
  assert.equal(proposal!.ref, 'issue:12:plan');
  // The ask carries the shape being weighed — one branch, one PR — rather than a
  // decomposition's part list, and says what each answer does.
  const esc = system.store.getEscalation(proposal!.escalationId!)!;
  assert.match(esc.prompt, /1 pull request/);
  // The branch is still named — a branch that already exists is exactly what the
  // other warnings on this ask are about — now by the appended arm paragraph.
  assert.match(esc.prompt, /one agent on issue\/12/);
  assert.match(esc.prompt, /Reject and the plan goes back to a planner/);
  assert.equal(system.store.listTasks().length, 0, 'nothing is worked before the acceptance step');

  // Repeated pulses neither re-ask nor start anything.
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1);
  assert.equal(system.store.listTasks().length, 0);
  system.store.close();
});

test('accepting a single verdict releases it to `single`, and the issue is picked up whole', async () => {
  const { system } = plannedSystem({ verdict: 'single' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const accepted = await system.proposals.accept(proposal.id, 'one PR is right');
  assert.equal(accepted!.outcome, 'performed');
  // `active` on either arm; which arm it is, is the parts, and this one has none.
  const released = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(released.status, 'active');
  assert.equal(planShape(system.store.listPlanParts(released.id)), 'single');
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`)!;
  assert.match(audited.detail, /released the single-pull-request plan for issue:12/);
  assert.match(audited.detail, /authorized by you/);

  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listTasks().map((t) => [t.originRef, t.branch]),
    [['issue:12', 'issue/12']],
  );
  system.store.close();
});

test('rejecting a single verdict sends it back to a planner with the reason, not into a wall', async () => {
  const { system } = plannedSystem({ verdict: 'single' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  system.proposals.reject(proposal.id, 'the migration has to land on its own');
  const plan = system.store.getPlanByOrigin('issue:12')!;
  // Falling back to `single` here would *perform* the thing that was refused, and
  // `abandoned` would park the issue. A replan is the only answer with a decision
  // left in it — the same status write `POST /api/plans/:id/replan` makes.
  assert.equal(plan.status, 'planning');
  assert.match(plan.reason!, /One reviewable change\./, "the planner's own reasoning is what is being amended");
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
function plannedSystem(opts: { requireApproval?: boolean; verdict?: 'single' | 'parts' } = {}): {
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
  if (opts.verdict === 'single') submitSingle(system, 'issue:12');
  else submitPlan(system, 'issue:12', ['schema', 'api']);
  return { system, repoRoot };
}

/** Land a planner's verdict the way both transports do — through the one ingestion. */
function submitPlan(system: System, originRef: string, slugs: string[]): void {
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
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

/** The other verdict, through the same ingestion: one agent, one branch, one PR. */
function submitSingle(system: System, originRef: string): void {
  const doc = parsePlanDocument(JSON.stringify({ version: 1, verdict: 'single', reason: 'One reviewable change.' }));
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
    blockedReason: refCollisionReason(12),
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
  const parts = [{ ...partRow('a', 1), status: 'blocked' as const, blockedReason: refCollisionReason(12) }];
  const warning = planApprovalWarnings(issue, parts, []);
  // Quoted off the row rather than recomposed, so the ask, the plate and the
  // Errors panel are one sentence.
  assert.ok(warning.includes(refCollisionReason(12)));
  assert.match(warning, /cannot be cut/);
});

test('abandoning a released decomposition falls the issue back to a single PR', () => {
  const store = new Store(':memory:');
  const plan = store.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'active', reason: null });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'a',
      seq: 1,
      title: 'A',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
    {
      slug: 'b',
      seq: 2,
      title: 'B',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);

  const settled = abandonDecomposition(store, plan.id, 'issue:12');
  assert.equal(settled.ok, true);
  // Retiring the parts *is* the collapse: no second status write to disagree with it.
  assert.equal(store.getPlan(plan.id)?.status, 'active');
  assert.equal(planShape(store.listPlanParts(plan.id)), 'single');
  assert.deepEqual(
    store.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
  );
  store.close();
});

test('abandon refuses what would strand real work, and what is not released yet', () => {
  const store = new Store(':memory:');
  const plan = store.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'awaiting_approval',
    reason: null,
  });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'a',
      seq: 1,
      title: 'A',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);

  // Not released: refusing is that plan's verdict, and this one is a different
  // sentence — collapsing the two would have one control mean two things.
  assert.equal(abandonDecomposition(store, plan.id, 'issue:12').ok, false);

  store.setPlanStatus(plan.id, 'active');
  const part = store.listPlanParts(plan.id)[0]!;
  store.updatePlanPart(part.id, { status: 'in_review', branch: 'issue/12/a', prNumber: 7 });
  const refused = abandonDecomposition(store, plan.id, 'issue:12');
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /work has already started/);
  assert.equal(store.getPlan(plan.id)?.status, 'active', 'and nothing moved');
  assert.equal(store.listPlanParts(plan.id)[0]?.status, 'in_review');
  store.close();
});

test('the abandon route is the way out of an approved decomposition, and guards the same rule', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  await system.proposals.accept(system.store.listProposals()[0]!.id);
  const plan = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(plan.status, 'active');

  const { app } = await buildApp(system);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/abandon' })).statusCode, 404);

  const done = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/abandon` });
  assert.equal(done.statusCode, 200);
  assert.equal(planShape(system.store.listPlanParts(plan.id)), 'single');
  assert.ok(
    system.store.listPlanParts(plan.id).every((p) => p.status === 'retired'),
    'nothing is left for rule `plan-part` to schedule',
  );

  // Idempotent by the same guard that makes it safe: a second click finds a plan
  // with no live parts — already worked whole — and 409s rather than re-retiring.
  assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/abandon` })).statusCode, 409);
  await app.close();
  system.store.close();
});
