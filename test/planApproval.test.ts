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
import { resolvePlanRoute } from '../src/plans/planning.js';
import { backOutCommentDraft } from '../src/plans/planBackOut.js';
import {
  actOnShortfall,
  describeProposedParts,
  planApprovalDetail,
  planApprovalNote,
  refusePlan,
} from '../src/plans/planApproval.js';
import { planIsWedged, wedgedPlanPrompt } from '../src/plans/planWedge.js';
import { caveatNotice, planCaveats, proposedCaveats, unacknowledgedCaveats } from '../src/plans/planCaveats.js';
import { refCollisionReason } from '../src/plans/planReconciler.js';
import { planProposalHold, planProposalRef } from '../src/proposals/proposals.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { PLAN_FILE, parsePlanDocument } from '../src/plans/planDocument.js';
import { Store } from '../src/store/store.js';
import type { DispatchVerdict } from '../src/dispatcher/dispatchCooldown.js';
import type { Agent, Issue, Plan, PlanPart, Proposal } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

// -- the pure half -----------------------------------------------------------

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

test('ingestion persists every verdict as a proposal, and the part count has no say in it', () => {
  const store = new Store(':memory:');
  const plan = (slugs: string[]) => {
    const doc = parsePlanDocument(
      JSON.stringify({
        version: 1,
        reason: 'Schema first.',
        parts: slugs.map((slug) => ({ slug, title: slug, scope: `src/${slug}/`, dependsOn: [] })),
      }),
    );
    assert.ok(doc.ok);
    return doc.document;
  };

  // Ingestion takes no policy at all: there is no argument here that could have
  // landed this as work, and none a transport could pass differently.
  const one = ingestPlanDocument(store, { doc: plan(['schema']), originRef: 'issue:12', title: 'Big thing' });
  assert.equal(one.status, 'awaiting_approval');
  // A one-part plan is put to the operator on exactly an eight-part plan's terms:
  // the decision is whether this work should happen, and the split is not what
  // makes it worth asking about.
  const many = ingestPlanDocument(store, {
    doc: plan(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
    originRef: 'issue:13',
    title: 'Other thing',
  });
  assert.equal(many.status, 'awaiting_approval');
  // Both wrote their parts: the gate holds scheduling, not the record of the verdict.
  assert.equal(store.listPlanParts(one.plan.id).length, 1);
  assert.equal(store.listPlanParts(many.plan.id).length, 8);
  store.close();
});

/**
 * A refusal retires the parts nothing was started for — and a retired human
 * part's ask goes with it.
 *
 * The bench is the operator's own to-do list, so an open row pointing at a part
 * no plan schedules is an obligation nothing can ever settle, and it is
 * indistinguishable there from one they still owe. Ingestion has always done
 * this for an amendment; both now reach the one `withdrawPartAsks`.
 */
test('refusing a plan withdraws the asks behind the steps it retires', () => {
  const store = new Store(':memory:');
  const { plan } = ingestPlanDocument(store, {
    doc: {
      version: 1,
      evidence: [],
      reason: 'A person has to flip it before anything can verify it.',
      parts: [
        {
          slug: 'flip',
          title: 'Flip the flag in the vendor console',
          scope: 'the vendor console',
          dependsOn: [],
          expectedKind: 'human',
          acceptance: 'The flag reads on.',
          touches: [],
        },
        { slug: 'code', title: 'Read the flag', scope: 'src/', touches: [], dependsOn: ['flip'] },
      ],
    },
    originRef: 'issue:12',
    title: 'Issue 12',
  });
  const step = store.listPlanParts(plan.id).find((p) => p.slug === 'flip')!;
  assert.equal(store.listHumanTasksForParts([step.id])[0]!.status, 'open');

  const settled = refusePlan(store, plan.id, 'issue:12', 'not like this');
  assert.equal(settled.ok, true);
  assert.deepEqual(
    store.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
  );

  const ask = store.listHumanTasksForParts([step.id])[0]!;
  assert.equal(ask.status, 'declined');
  assert.match(ask.resolution ?? '', /sent back to a planner/);
  assert.equal(
    store.listHumanTasks().filter((t) => t.status === 'open').length,
    0,
    'nothing is left on the bench for a part no plan schedules',
  );
  store.close();
});

test('both transports honour the gate, so a verdict lands the same way whichever carried it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
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
  assert.ok(accepted && 'outcome' in accepted, 'this plan raises no caveats, so nothing gates the accept');
  assert.equal(accepted.outcome, 'performed');
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

test('the closing draft quotes what was planned, and is a draft rather than a default', () => {
  // The ticket's readers have not seen the plan — it lives in the cockpit — so a
  // "not doing this" with no account of what was considered reads as nobody having
  // looked. Nothing posts it: the route serves it and the operator edits it.
  const draft = backOutCommentDraft(
    {
      diagnosis: 'The signer is cached at module load.',
      approach: 'Resolve it per request instead.',
      reason: 'Two seams, two reviews.',
    },
    12,
  );
  assert.match(draft, /Closing #12 without doing the work/);
  assert.match(draft, /cached at module load/);
  assert.match(draft, /it can be picked up again/);
  // A planner that filled in neither still leaves a usable draft rather than a
  // heading with nothing under it.
  const bare = backOutCommentDraft({ diagnosis: null, approach: null, reason: null }, 12);
  assert.match(bare, /Closing #12/);
  assert.doesNotMatch(bare, /for the record/);
});

test('closing the ticket stops the goal for good, and says so on the ticket', async () => {
  const { system } = plannedSystem({ labelPrefix: 'lubbdubb' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const backed = await system.proposals.backOut(proposal.id, 'close', 'Duplicate of #7 — nothing to build here.');
  assert.equal(backed!.outcome, 'none');
  // The plan stops where it is rather than going back to a planner, which is the
  // whole difference from a rejection: re-planning a goal nobody wants is what the
  // operator was trying to avoid by pressing this.
  const plan = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(plan.status, 'abandoned');
  assert.match(plan.reason!, /Schema first\./);
  assert.match(plan.reason!, /Duplicate of #7/);
  assert.deepEqual(
    system.store.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
  );
  // The harness's own record is what stops the re-pickup, and it carries the
  // operator's words rather than a bare "done".
  const conclusion = system.store.getIssueConclusion('issue:12')!;
  assert.equal(conclusion.verdict, 'done');
  assert.match(conclusion.note, /Duplicate of #7/);
  // And the ticket itself: commented, closed, and un-watched — the audit line says
  // each of the three, because an operator told "closed" over an open ticket has
  // been lied to about the thing they were deciding.
  assert.match(backed!.detail, /commented on #12/);
  assert.match(backed!.detail, /closed #12 as not planned/);
  assert.match(backed!.detail, /dropped the watch tag/);
  // The tag is patched onto the baseline the moment it lands, the way the cockpit's
  // own toggle patches it: `/api/state` serves the baseline, so a cockpit redrawn
  // before the next sweep would otherwise show the goal still watched.
  assert.deepEqual(system.store.getWorldBaseline()!.issues.find((i) => i.number === 12)!.labels, []);

  // The inbox empties on the click, and nothing is scheduled on any later pulse —
  // no planner, no part, no second card.
  assert.equal(system.store.getEscalation(proposal.escalationId!)!.status, 'answered');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  // The close itself shows up the way every other provider write does: on the next
  // sweep of the world, rather than as a belief the harness holds separately.
  assert.equal(system.store.getWorldBaseline()!.issues.find((i) => i.number === 12)!.state, 'closed');
  assert.equal(system.store.listTasks().length, 0);
  assert.equal(system.store.listProposals().length, 1);
  system.store.close();
});

test('holding the ticket stops the watching and sends the plan back, so it is planned afresh', async () => {
  const { system } = plannedSystem({ labelPrefix: 'lubbdubb' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  const held = await system.proposals.backOut(proposal.id, 'hold', 'Needs a product call first.');
  assert.match(held!.detail, /dropped the watch tag on 1 item\(s\)/);
  // The plan is refused rather than parked: a hold says the thinking is not
  // finished, and re-proposing the same decomposition weeks later would ask the
  // operator to approve a plan written before whatever they were waiting on.
  const plan = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(plan.status, 'planning');
  assert.match(plan.reason!, /Schema first\./, "the planner's own reasoning is what is being amended");
  assert.match(plan.reason!, /Needs a product call first/);
  assert.deepEqual(
    system.store.listPlanParts(plan.id).map((p) => p.status),
    ['retired', 'retired'],
    'parts nothing started are retired, exactly as a refusal retires them',
  );
  // Nothing is concluded and nothing is said on the ticket — a hold is not a
  // verdict about the work, and the goal is not finished.
  assert.equal(system.store.getIssueConclusion('issue:12'), null);
  assert.doesNotMatch(held!.detail, /closed #12/);
  assert.doesNotMatch(held!.detail, /commented on #12/);
  const issue = system.store.getWorldBaseline()!.issues.find((i) => i.number === 12)!;
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.labels, []);

  // Un-watched, the replan the refusal sets up costs nothing: rule `issue-plan`
  // dispatches for an eligible issue, and this one is not one.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listTasks().length, 0);
  assert.equal(system.store.listProposals().length, 1);

  // Watching it again is what starts a planner — and what it writes is a *new*
  // plan, not this one put back up. That is the whole of the hold: the thinking
  // resumes where the operator left it, rather than an old decomposition being
  // re-proposed after whatever they were waiting on happened.
  await system.connector.setIssueLabel({ number: 12, label: 'lubbdubb-watch', present: true });
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listTasks().map((t) => t.originRef),
    ['issue:12:plan'],
  );
  assert.equal(system.store.listProposals().filter((p) => p.status === 'pending').length, 0);
  system.store.close();
});

test('backing out is refused for anything but a plan, and settles exactly once', async () => {
  const { system } = plannedSystem({ labelPrefix: 'lubbdubb' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  // A merge has no ticket behind it to close or hold — the act is on a pull
  // request — so the desk refuses rather than settling a verdict whose effect
  // cannot run. Refused *before* the transition, so the merge is still decidable.
  const merge = system.store.createProposal({
    kind: 'merge',
    ref: 'pr:7:merge',
    action: { type: 'merge_pr', reason: 'green', prNumber: 7, method: 'squash' },
    escalationId: null,
  });
  assert.equal(await system.proposals.backOut(merge.id, 'close', 'not a ticket'), null);
  assert.equal(system.store.getProposal(merge.id)!.status, 'pending');

  // And the plan's own verdict is one-way, exactly as accepting and rejecting are:
  // a second click changes nothing and does not comment on the ticket twice.
  assert.ok(await system.proposals.backOut(proposal.id, 'close', 'Duplicate of #7.'));
  assert.equal(await system.proposals.backOut(proposal.id, 'close', 'again'), null);
  assert.equal(await system.proposals.backOut(proposal.id, 'hold', 'or this'), null);
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'abandoned');
  system.store.close();
});

test('a one-part plan is asked about on the same terms, and schedules its part once approved', async () => {
  const { system } = plannedSystem({ slugs: ['whole'] });
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');
  await system.harness.runCycle('manual');

  const proposal = system.store.listProposals()[0]!;
  assert.equal(proposal.ref, 'issue:12:plan', 'one part is still a verdict somebody is asked about');
  assert.equal(system.store.listTasks().length, 0);
  await system.proposals.accept(proposal.id, 'fine');
  await system.harness.runCycle('manual');

  // The part, on the part branch, through rule `plan-part` — not the issue on the
  // flat branch through rule `issue-pickup`. That second path was what "one pull
  // request" used to mean, and it is the whole difference this removes.
  assert.deepEqual(
    system.store.listTasks().map((t) => [t.originRef, t.branch]),
    [['issue:12:part:whole', 'issue/12/whole']],
  );
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
  assert.ok(accepted && 'outcome' in accepted, 'this plan raises no caveats, so nothing gates the accept');
  assert.equal(accepted.outcome, 'performed');
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

test('a close with no words is refused, and the draft is served rather than posted', async () => {
  const { system } = plannedSystem({ labelPrefix: 'lubbdubb' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;
  const { app } = await buildApp(system);

  // The note is what goes on somebody's tracker as the reason it closed, and it
  // outlives this harness — so an empty one is a refusal rather than a close with
  // a comment the harness composed and nobody read.
  const empty = await app.inject({
    method: 'POST',
    url: `/api/proposals/${proposal.id}/back-out`,
    payload: { verdict: 'close' },
  });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /note is required/);
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');

  // The draft is there to be edited into one. Serving it posts nothing: the plan
  // is still awaiting approval and the ticket is untouched.
  const draft = await app.inject({ method: 'GET', url: `/api/proposals/${proposal.id}/comment-draft` });
  assert.equal(draft.statusCode, 200);
  assert.match(draft.json().draft, /Closing #12/);
  assert.match(draft.json().draft, /two writers disagree/);
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');
  assert.equal(system.store.getWorldBaseline()!.issues.find((i) => i.number === 12)!.state, 'open');

  // A hold needs no words at all — it decides nothing about the work.
  const held = await app.inject({
    method: 'POST',
    url: `/api/proposals/${proposal.id}/back-out`,
    payload: { verdict: 'hold' },
  });
  assert.equal(held.statusCode, 200);
  assert.equal(system.store.getProposal(proposal.id)!.status, 'rejected');
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
    blockedBy: null,
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
function plannedSystem(opts: { slugs?: string[]; labelPrefix?: string; unsure?: boolean } = {}): {
  system: System;
  repoRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const repoRoot = gitRepo();
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    labelPrefix: opts.labelPrefix ?? '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  // Watched where the deployment has a tag at all: rule `plan-approval` asks about
  // an open, watched issue, and the back-out's whole mechanism is that tag.
  const labels = opts.labelPrefix ? [`${opts.labelPrefix}-watch`] : [];
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Big thing', body: 'Several PRs.', labels });
  submitPlan(system, 'issue:12', opts.slugs ?? ['schema', 'api'], opts.unsure ?? false);
  return { system, repoRoot };
}

/** Land a planner's plan the way both transports do — through the one ingestion. */
function submitPlan(system: System, originRef: string, slugs: string[], unsure = false): void {
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Schema first.',
      diagnosis: 'The column is nullable and two writers disagree about it.',
      approach: 'Make it non-null with a backfill, then teach both writers the one shape.',
      // The planner's own uncertainty, which is what an approval has to have been
      // read against — see `src/plans/planCaveats.ts`.
      ...(unsure
        ? {
            openQuestions: 'Whether the backfill can run online, or needs the table locked.',
            risks: 'A long lock would take writes down for the length of the backfill.',
          }
        : {}),
      parts: slugs.map((slug) => ({ slug, title: slug, scope: `src/${slug}/`, dependsOn: [] })),
    }),
  );
  assert.ok(doc.ok);
  ingestPlanDocument(system.store, { doc: doc.document, originRef, title: 'Big thing' });
}

test('a plan that raises caveats is not approved until each of them is acknowledged', async () => {
  const { system } = plannedSystem({ unsure: true });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  // What the operator has to have read rides on the action the verdict is given
  // against, so the boxes the cockpit draws and the gate on the accept are one list.
  const caveats = proposedCaveats(proposal);
  assert.deepEqual(
    caveats.map((c) => c.id),
    ['open-questions', 'risks'],
  );
  assert.match(caveats[0]!.detail ?? '', /needs the table locked/);
  // Each label is a title and the detail is what it is about: a label that states
  // its whole case is the appended paragraph back again, one checkbox at a time.
  for (const c of caveats) {
    assert.ok(c.label.length <= 60, `caveat ${c.id} label is a paragraph, not a title: ${c.label}`);
    assert.ok(!c.label.includes('. '), `caveat ${c.id} label runs to a second sentence: ${c.label}`);
  }
  // And the ask says the accept is held, appended rather than templated so an
  // override cannot drop it.
  const esc = system.store.getEscalation(proposal.escalationId!)!;
  assert.match(esc.prompt, /Approving is held until each of these is acknowledged/);

  // An accept that names none of them decides nothing at all: the row is still
  // pending, so the operator ticks the boxes and clicks again rather than finding
  // a verdict spent.
  const refused = await system.proposals.accept(proposal.id, 'looks fine');
  assert.ok(refused && 'unacknowledged' in refused);
  assert.deepEqual(
    refused.unacknowledged.map((c) => c.id),
    ['open-questions', 'risks'],
  );
  assert.equal(system.store.getProposal(proposal.id)!.status, 'pending');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');

  // Half of them is still not the plan being read.
  const half = await system.proposals.accept(proposal.id, 'looks fine', ['risks']);
  assert.ok(half && 'unacknowledged' in half);
  assert.deepEqual(
    half.unacknowledged.map((c) => c.id),
    ['open-questions'],
  );

  const accepted = await system.proposals.accept(proposal.id, 'the lock is fine', ['open-questions', 'risks']);
  assert.ok(accepted && 'outcome' in accepted);
  assert.equal(accepted.outcome, 'performed');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'active');
  system.store.close();
});

test('only the accept is gated — a rejection needs no acknowledgement', async () => {
  const { system } = plannedSystem({ unsure: true });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;

  // Saying no is a way of *not* releasing the work, so putting a reading list in
  // front of it would be friction on the safe verdict.
  const rejected = system.proposals.reject(proposal.id, 'wrong shape');
  assert.ok(rejected && 'outcome' in rejected);
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'planning');
  system.store.close();
});

test('a plan that raises nothing is approved on the click it always was', async () => {
  const { system } = plannedSystem();
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;
  assert.deepEqual(proposedCaveats(proposal), [], 'no uncertainty, no blocked part, no unclaimed PR');
  assert.deepEqual(unacknowledgedCaveats([], []), []);
  const accepted = await system.proposals.accept(proposal.id);
  assert.ok(accepted && 'outcome' in accepted);
  assert.equal(accepted.outcome, 'performed');
  system.store.close();
});

// -- the wedge: a plan approved onto a branch its parts cannot sit beneath -----

const collided = (slug: string, seq: number): PlanPart => ({
  ...partRow(slug, seq),
  status: 'blocked',
  blockedReason: refCollisionReason(12, { local: true, remote: false }),
  blockedBy: 'collision',
});

const refused = (slug: string, seq: number): PlanPart => ({
  ...partRow(slug, seq),
  status: 'blocked',
  blockedReason: `"The ${slug} part" is a step for a person, and it was declined.`,
  blockedBy: 'declined',
});

test('planIsWedged needs something blocked and nothing moving, and ignores retired ones', () => {
  assert.equal(planIsWedged([collided('a', 1), collided('b', 2)]), true);
  // One part still moving is a plan still making progress — a `ready` part is
  // dispatchable, and a `ready` *human* part is visible on the bench.
  assert.equal(planIsWedged([collided('a', 1), partRow('b', 2)]), false);
  assert.equal(planIsWedged([collided('a', 1), { ...partRow('b', 2), status: 'dispatched' }]), false);
  assert.equal(planIsWedged([{ ...partRow('a', 1), status: 'retired' }, collided('b', 2)]), true);
  // Empty is not wedged but empty — a different thing, left to say so itself.
  assert.equal(planIsWedged([]), false);
  assert.equal(planIsWedged([{ ...partRow('a', 1), status: 'retired' }]), false);
  // Nothing blocked at all is not a wedge however stuck the plan looks: a `pending`
  // part is waiting on a sibling, which is the scheduler working.
  assert.equal(planIsWedged([{ ...partRow('a', 1), status: 'pending' }]), false);
});

test('a settled sibling no longer hides a wedge, and a decline no longer invents one', () => {
  // Direction B: `[merged, blocked, pending]`. `every` said no because a merged part
  // is not a blocked one, and the goal then stalled for good with nothing in
  // "Needs you" — no `ready` part for `plan-part`, the plan still `active` so
  // `issue-assess` skips it, the route still `parts` so `issue-pickup` skips it.
  const merged: PlanPart = { ...partRow('build', 1), status: 'merged' };
  assert.equal(planIsWedged([merged, collided('sign', 2), { ...partRow('ship', 3), status: 'pending' }]), true);

  // Direction A: the operator declined the only step. Specs 08 and 13 both say
  // nothing escalates for a decline — the button is in front of the person who
  // pressed it — and there is nothing else stuck behind it.
  assert.equal(planIsWedged([refused('sign', 1)]), false);
  assert.equal(planIsWedged([merged, refused('sign', 2)]), false);

  // But a decline that strands work nobody refused is a plan going nowhere, and
  // that is the question `plan-blocked` exists to ask.
  assert.equal(planIsWedged([merged, refused('sign', 2), { ...partRow('ship', 3), status: 'pending' }]), true);

  // A blocked row from before `blocked_by` existed is unattributed, and counts —
  // the pre-column behaviour, which is the direction that keeps a collision
  // escalating rather than silently dropping it.
  const unattributed: PlanPart = { ...collided('a', 1), blockedBy: null };
  assert.equal(planIsWedged([unattributed]), true);
});

test('the wedge prompt offers clearing a branch only when a branch is what is blocking', () => {
  const issue: Issue = {
    id: 'i12',
    number: 12,
    title: 'Big thing',
    state: 'open',
    labels: [],
    body: '',
    linkedPrNumber: null,
  };
  const collision = wedgedPlanPrompt(12, issue, [collided('a', 1), collided('b', 2)], []);
  assert.match(collision, /every one of its parts is blocked/);
  assert.match(collision, /clear what is blocking the parts/);

  const decline = wedgedPlanPrompt(
    12,
    issue,
    [{ ...partRow('build', 1), status: 'merged' }, refused('sign', 2), { ...partRow('ship', 3), status: 'pending' }],
    [],
  );
  assert.match(decline, /1 of its 2 unfinished parts is blocked and nothing else is moving/);
  assert.doesNotMatch(decline, /clear what is blocking/, 'clearing reaches nothing a decline holds');
  assert.doesNotMatch(decline, /branch is free/, 'and there is no branch problem to describe');
  assert.match(decline, /the block is a step you declined/);
  assert.match(decline, /Replan/);

  // Two declines name two different steps, so both sentences are quoted.
  const two = wedgedPlanPrompt(12, issue, [refused('sign', 1), refused('ack', 2), partRow('ship', 3)], []);
  assert.match(two, /"The sign part"/);
  assert.match(two, /"The ack part"/);
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

  const clean = { risks: null, openQuestions: null };
  // The box is titled by the PR; what approving does not do is the detail under it.
  const [unclaimed] = planCaveats(clean, issue, parts, [pr]);
  assert.equal(unclaimed!.label, 'PR #31231 is open on this issue and unclaimed');
  const warning = caveatNotice(planCaveats(clean, issue, parts, [pr]));
  assert.match(warning, /PR #31231/);
  assert.match(warning, /belongs to no part/);
  // It says what approving does *not* do, because nothing here knows which part
  // the PR satisfies — naming it is the whole contribution.
  assert.match(warning, /does not close it, hand it to a part/);

  // A part that has claimed the PR is the ordinary working plan: nothing to say.
  assert.deepEqual(planCaveats(clean, issue, [{ ...parts[0]!, prNumber: 31231 }, parts[1]!], [pr]), []);
  // And a plan with nothing open against its issue warns about nothing at all,
  // so nothing is appended to the ask.
  assert.equal(caveatNotice(planCaveats(clean, { ...issue, linkedPrNumber: null }, parts, [])), '');
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
  const warning = caveatNotice(planCaveats({ risks: null, openQuestions: null }, issue, parts, []));
  // Quoted off the row rather than recomposed, so the ask, the plate and the
  // Errors panel are one sentence.
  assert.ok(warning.includes(refCollisionReason(12, { local: true, remote: false })));
  assert.match(warning, /cannot be cut/);
});

test('the wedge escalation names the PR holding the branch', () => {
  // Approval was days ago, so the approval caveats having said it once is not
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

// Issue #559 — arm B once the follow-up it appended has itself finished.
//
// `<slug>-followup` collides on purpose while the follow-up is still a
// declaration; `upsertPlanParts` preserving progress is what turns that same
// collision into a no-op once the follow-up has merged — nothing scheduled, the
// merged part's declaration rewritten, and every surface reporting an append.

function shortfallStore(): { store: Store; planId: string } {
  const store = new Store(':memory:');
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'One part.',
      parts: [{ slug: 'api', title: 'Build the API', scope: 'the api', dependsOn: [] }],
    }),
  );
  assert.ok(doc.ok);
  const { plan } = ingestPlanDocument(store, { doc: doc.document, originRef: 'issue:12', title: 'Add the API' });
  store.setPlanStatus(plan.id, 'active');
  return { store, planId: plan.id };
}

/** Mark a part terminal the way the reconciler does when its PR merges. */
function merge(store: Store, planId: string, slug: string, prNumber: number): void {
  const part = store.listPlanParts(planId).find((p) => p.slug === slug)!;
  store.updatePlanPart(part.id, { status: 'merged', branch: `issue/12/${slug}`, prNumber });
  store.rollUpPlanStatus(planId);
}

test('a second shortfall on a part whose follow-up merged appends a new part, not a rewrite', () => {
  const { store, planId } = shortfallStore();
  merge(store, planId, 'api', 40);
  assert.equal(store.getPlan(planId)!.status, 'complete');

  const first = actOnShortfall(store, {
    planId,
    originRef: 'issue:12',
    cause: 'part',
    partSlug: 'api',
    summary: 'the endpoint returns 500 on empty input',
  });
  assert.equal(first.ok, true);
  assert.match(first.detail, /appended part "api-followup"/);
  assert.equal(store.getPlan(planId)!.status, 'active', 'an unsettled part makes the roll-up false again');

  merge(store, planId, 'api-followup', 41);
  assert.equal(store.getPlan(planId)!.status, 'complete');

  const second = actOnShortfall(store, {
    planId,
    originRef: 'issue:12',
    cause: 'part',
    partSlug: 'api',
    summary: 'it still 500s on a null body',
  });
  assert.equal(second.ok, true, 'the accept spends an agent, so it must not settle the verdict for nothing');
  assert.match(second.detail, /appended part "api-followup-2"/);

  const parts = store.listPlanParts(planId);
  const appended = parts.find((p) => p.slug === 'api-followup-2');
  assert.ok(appended, 'a real append: the taken slot took the next free number');
  assert.equal(appended!.status, 'pending');
  assert.match(appended!.scope, /null body/);

  const merged = parts.find((p) => p.slug === 'api-followup')!;
  assert.equal(merged.status, 'merged');
  assert.equal(merged.scope, 'the endpoint returns 500 on empty input', 'a merged declaration is never rewritten');
  assert.match(merged.title, /Finish "Build the API"/);
  assert.equal(parts.find((p) => p.slug === 'api')!.scope, 'the api', 'and neither is the part that fell short');
  assert.equal(store.getPlan(planId)!.status, 'active', 'the plan rolls back to active, which is what dispatches');
  store.close();
});

test('a follow-up part that itself falls short is left as it is, and followed up again', () => {
  const { store, planId } = shortfallStore();
  merge(store, planId, 'api', 40);
  actOnShortfall(store, {
    planId,
    originRef: 'issue:12',
    cause: 'part',
    partSlug: 'api',
    summary: 'the endpoint returns 500 on empty input',
  });
  merge(store, planId, 'api-followup', 41);

  // The short way in: the shortfall names the follow-up, so the slug rule's
  // idempotence makes the target its own collision.
  const settled = actOnShortfall(store, {
    planId,
    originRef: 'issue:12',
    cause: 'part',
    partSlug: 'api-followup',
    summary: 'and now it 404s',
  });
  assert.equal(settled.ok, true);
  assert.match(settled.detail, /appended part "api-followup-2"/);

  const parts = store.listPlanParts(planId);
  assert.equal(parts.find((p) => p.slug === 'api-followup-2')!.status, 'pending');
  assert.equal(
    parts.find((p) => p.slug === 'api-followup')!.scope,
    'the endpoint returns 500 on empty input',
    'the part that fell short is untouched, as the detail says',
  );
  assert.equal(store.getPlan(planId)!.status, 'active');
  store.close();
});

test('a follow-up nobody has started is still refreshed in place', () => {
  const { store, planId } = shortfallStore();
  merge(store, planId, 'api', 40);
  actOnShortfall(store, { planId, originRef: 'issue:12', cause: 'part', partSlug: 'api', summary: 'first reading' });

  const again = actOnShortfall(store, {
    planId,
    originRef: 'issue:12',
    cause: 'part',
    partSlug: 'api',
    summary: 'a better reading of the same gap',
  });
  assert.equal(again.ok, true);
  assert.match(again.detail, /refreshed the declaration of the unstarted follow-up part "api-followup"/);

  const parts = store.listPlanParts(planId);
  assert.equal(parts.filter((p) => p.slug.startsWith('api-followup')).length, 1, 'no -followup-2 for an idle slot');
  assert.equal(parts.find((p) => p.slug === 'api-followup')!.scope, 'a better reading of the same gap');
  store.close();
});
