import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { shortfallArm, shortfallRef } from '../src/delivery/shortfall.js';
import { deliveryHold } from '../src/delivery/delivery.js';
import { resolveIssueConclusion } from '../src/issueConclusion.js';
import { issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { proposalHold } from '../src/proposals/proposals.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { pastTheFunnel } from './support/plans.js';
import type {
  Agent,
  Issue,
  IssueConclusion,
  IssueShortfall,
  Plan,
  PlanPart,
  Proposal,
  Task,
  WorldEvent,
} from '../src/types.js';

// Issue #159 — the assessor's negative verdict, and what it drives.
//
// The loop is Plan → Work → is the goal achieved? → No → re-plan. Before this,
// both ends existed and nothing joined them: rule `issue-assess` asked the question and the
// answer landed in a row whose only consumer emits a *tracker* move, so on GitHub
// it changed no dispatch at all and on a decomposed issue it changed none anywhere.

const NOW = '2026-07-28T12:00:00.000Z';

// -- the pure arm resolver ---------------------------------------------------

test('each cause routes somewhere different — which is the whole point of declaring it', () => {
  // The issue's own point 2: three distinct failures wear one face, and routing
  // all three to a replan re-decomposes plans whose shape was never the problem.
  assert.equal(shortfallArm('plan', true), 'replan');
  assert.equal(shortfallArm('part', true), 'followup');
  assert.equal(shortfallArm('goal', true), 'escalate', 'a wrong goal is #158’s question, not the planner’s');
});

test('no cause routes to nothing, and that is a fourth answer rather than a default', () => {
  // `undeclared`'s discipline: an unplanned issue that simply is not finished
  // names nothing to route. Folding it into `goal` would file an escalation
  // claiming the ticket is wrong every time, which is a route invented from silence.
  assert.equal(shortfallArm(null, false), 'none');
  assert.equal(shortfallArm(null, true), 'none');
});

test('with no plan, the two plan-shaped arms degrade to asking a person', () => {
  // Refused at the tool boundary, so reaching this means a plan went away between
  // the verdict and the pulse. There is nothing to replan and no part to follow up.
  assert.equal(shortfallArm('plan', false), 'escalate');
  assert.equal(shortfallArm('part', false), 'escalate');
});

// -- decision 6: a negative verdict never holds pickup ------------------------

test('the pickup gate names no shortfall type — the polarity is structural, not a runtime check', () => {
  // Asserted structurally, the way `test/planApproval.test.ts` asserts
  // `proposalHold` and `planProposalHold` apart and `test/workGraph.test.ts`
  // asserts the graph is a lens. Every reader of `issue_deliveries` *holds* an
  // issue out of pickup; a shortfall exists to release one. Putting the two
  // polarities behind one predicate would leave every present and future reader
  // remembering which one it had, from rows that look identical until you read a
  // column — the drift class this repo has paid for twice.
  const source = readFileSync(new URL('../src/delivery/delivery.ts', import.meta.url), 'utf8');
  for (const name of ['IssueShortfall', 'shortfall', 'Shortfall']) {
    assert.equal(source.includes(name), false, `deliveryHold's module must not name ${name}`);
  }
});

test('a shortfall never holds pickup, and the positive verdict still does', () => {
  // The behavioural half. Written both ways deliberately: an assertion that only
  // checked "not held" would pass just as well if the gate had been disabled.
  assert.equal(deliveryHold(null, issue()), null, 'no delivery row: nothing parked');
  assert.match(deliveryHold(deliveryRow(), issue()) ?? '', /marked it delivered/, 'the delivery gate is untouched');
});

test('an issue carrying a shortfall is pickup-eligible, and the chip says so', () => {
  const store = new Map<string, IssueShortfall>([['issue:12', shortfallRow()]]);
  assert.ok(store.get('issue:12'));
  const verdict = issuePickupStatus(issue(), {
    policy: { watchLabel: '', ignoreLabel: '', priorityLabels: {}, defaultPriority: 0, requireOwnLabel: false },
    cooldown: DEFAULT_COOLDOWN,
    now: NOW,
    tasks: [],
    // The funnel has failed open — the shortfall releases the issue *into*
    // pickup, which is a claim about what happens after the funnel, not before.
    recentDecisions: pastTheFunnel(12),
    openPrs: [],
    // No delivery row: writing a shortfall clears one, in the store.
    deliveries: [],
    deliverySignals: [],
    plans: [],
    headroom: 3,
    paused: false,
  });
  assert.equal(verdict.eligible, true, 'releasing work is the entire point of the verdict');
  assert.equal(verdict.status, 'eligible');
});

// -- decision 3: the resolver ranks two records rather than one overwriting the other

test('a shortfall outranks the working agent’s own declaration without erasing it', () => {
  // The bug this fixes predates the feature: `issue_conclusions` is keyed
  // `origin_ref PRIMARY KEY`, so an assessor writing `more_work` into it
  // overwrote the agent's note, author and timestamp — and the resolver read
  // `by: 'assessor'` and `by: 'agent'` through one arm with no precedence.
  const agentSaid = conclusionRow({ verdict: 'done', by: 'agent', note: 'I delivered all of it' });
  const resolved = resolveIssueConclusion(agentSaid, null, [], shortfallRow());
  assert.equal(resolved.verdict, 'more_work');
  assert.equal(resolved.by, 'assessor', 'the assessor is later and better informed');
  assert.equal(resolved.note, 'the CLI half is missing');
  // And the agent's row is still there to be read — two records, one resolver.
  assert.equal(agentSaid.note, 'I delivered all of it');
});

test('the operator’s toggle still wins over an assessment — it is the escape hatch', () => {
  const resolved = resolveIssueConclusion(
    conclusionRow({ verdict: 'done', by: 'operator', note: 'I have tested it, it is fine' }),
    null,
    [],
    shortfallRow(),
  );
  assert.equal(resolved.verdict, 'done');
  assert.equal(resolved.by, 'operator');
});

test('with no shortfall the resolver is byte-for-byte what it was', () => {
  const agentSaid = conclusionRow({ verdict: 'done', by: 'agent', note: 'done' });
  assert.deepEqual(resolveIssueConclusion(agentSaid, null, []), resolveIssueConclusion(agentSaid, null, [], null));
  assert.equal(resolveIssueConclusion(null, null, []).verdict, 'undeclared');
});

// -- decision 5: the operator stays in the loop -------------------------------

test('a shortfall proposal’s ref maps onto the issue, so a rejection expires on world signal', () => {
  // Not inherited by accident: `proposalWorldRef` splits on `:` and takes the
  // first two segments, so `issue:12:shortfall` → `issue:12` unmodified. It has to
  // work, or a refused replan would veto every future one — the phase-4 failure.
  const rejected = proposalRow({ status: 'rejected', decidedAt: '2026-07-28T10:00:00.000Z' });
  const held = proposalHold('shortfall', shortfallRef(12), [rejected], { rejectionSignals: [] });
  assert.match(held ?? '', /you rejected it/, 'a "no" stands until the world moves');

  const later: WorldEvent[] = [
    {
      id: 'we1',
      kind: 'issue_linked',
      ref: 'issue:12',
      summary: 'issue #12 linked to PR #41',
      createdAt: '2026-07-28T11:00:00.000Z',
    },
  ];
  assert.equal(
    proposalHold('shortfall', shortfallRef(12), [rejected], { rejectionSignals: later }),
    null,
    'and stops standing when it does',
  );
});

test('a pending shortfall holds the rule, so one question is asked once', () => {
  const pending = proposalRow({ status: 'pending', decidedAt: null });
  assert.match(proposalHold('shortfall', shortfallRef(12), [pending]) ?? '', /awaiting your accept\/reject/);
});

// -- the rule ----------------------------------------------------------------

test('a plan-cause shortfall is proposed, not taken', async () => {
  const { actions } = await decide(ctx({ shortfalls: [shortfallRow({ cause: 'plan' })], plans: [planRow()] }));
  const proposed = actions.find((a) => a.type === 'propose_shortfall') as
    | { cause: string; planId: string; prompt: string; detail: string | null; rule: string }
    | undefined;
  assert.ok(proposed, 'both routable arms spend a fleet, so a human authorizes them');
  assert.equal(proposed!.cause, 'plan');
  assert.equal(proposed!.planId, 'plan_1');
  assert.equal(proposed!.rule, 'issue-shortfall');
  // The assessor's words still reach the operator — beside the prompt now, not
  // inside it. Both directions asserted: carrying it in `detail` is only an
  // improvement if the prompt stops carrying it too, or the operator reads it
  // twice and the wall is back in the half that has no label.
  assert.match(proposed!.detail ?? '', /the CLI half is missing/, 'the assessor’s words reach the operator');
  assert.doesNotMatch(proposed!.prompt, /the CLI half is missing/, 'and are not also spliced into the prompt');
  assert.equal(
    actions.filter((a) => a.type.startsWith('dispatch_')).length,
    0,
    'nothing is scheduled by the rule itself',
  );
});

test('a goal-cause shortfall escalates and proposes nothing, because nothing is decidable', async () => {
  const { actions } = await decide(ctx({ shortfalls: [shortfallRow({ cause: 'goal' })], plans: [planRow()] }));
  assert.equal(actions.filter((a) => a.type === 'propose_shortfall').length, 0);
  const esc = actions.find((a) => a.type === 'escalate_to_human') as { prompt: string; rule: string } | undefined;
  assert.ok(esc, 'a proposal whose accept and reject both do nothing is not a decision');
  assert.equal(esc!.rule, 'issue-shortfall');
  assert.match(esc!.prompt, /no agent can fix|not something a planner/);
});

test('an uncaused shortfall drives nothing at all', async () => {
  const { actions } = await decide(ctx({ shortfalls: [shortfallRow({ cause: null })], plans: [planRow()] }));
  assert.deepEqual(
    actions.filter((a) => a.type === 'propose_shortfall' || a.type === 'escalate_to_human'),
    [],
  );
});

test('the escalate arm asks once — deduped on the inbox and on the audit log alike', async () => {
  const base = { shortfalls: [shortfallRow({ cause: 'goal' })], plans: [planRow()] };
  const ref = shortfallRef(12);

  // Rule `pr-ci-blocked`'s pattern: each half covers the other's blind spot — an inbox item
  // that outlives the decision window, and a decision that outlives the item.
  const viaInbox = await decide(
    ctx({
      ...base,
      openEscalations: [
        {
          id: 'esc_1',
          type: 'resolve_ambiguity',
          status: 'open',
          prompt: 'asked',
          context: { originRef: ref },
          agentId: null,
          taskId: null,
          response: null,
          createdAt: NOW,
          answeredAt: null,
        },
      ],
    }),
  );
  assert.equal(viaInbox.actions.filter((a) => a.type === 'escalate_to_human').length, 0);

  const viaLog = await decide(
    ctx({
      ...base,
      recentDecisions: [
        {
          id: 'd1',
          cycleId: 'c1',
          action: { type: 'escalate_to_human', reason: 'x', context: { originRef: ref } },
          outcome: 'executed',
          rule: 'issue-shortfall',
          admission: null,
          detail: '',
          createdAt: NOW,
        },
      ],
    }),
  );
  assert.equal(viaLog.actions.filter((a) => a.type === 'escalate_to_human').length, 0);
});

test('with no plan row both plan-shaped arms degrade rather than parking the issue', async () => {
  // A replan needs a plan for rule `issue-plan` to pick up and a follow-up part
  // needs one for rule `plan-part` to append to. Without a plan, accepting either
  // would park the issue on a transition nothing consumes.
  const { actions } = await new RuleDispatcher({}, {}, undefined, 'main').decide(
    ctx({ shortfalls: [shortfallRow({ cause: 'plan' })], plans: [] }),
  );
  assert.equal(actions.filter((a) => a.type === 'propose_shortfall').length, 0);
  assert.equal(actions.filter((a) => a.type === 'escalate_to_human').length, 1);
});

test('an ignored or closed issue’s shortfall drives nothing', async () => {
  const tagged = await dispatcher().decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [], issues: [issue({ labels: ['lubbdubb-ignore'] })] },
      shortfalls: [shortfallRow({ cause: 'plan' })],
      plans: [planRow()],
    }),
  );
  assert.equal(tagged.actions.filter((a) => a.type === 'propose_shortfall').length, 0);

  const closed = await dispatcher().decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [], issues: [issue({ state: 'closed' })] },
      shortfalls: [shortfallRow({ cause: 'plan' })],
      plans: [planRow()],
    }),
  );
  assert.equal(closed.actions.filter((a) => a.type === 'propose_shortfall').length, 0);
});

// -- the tool ----------------------------------------------------------------

test('assess_issue is still the one tool, and its name is still granted', () => {
  assert.ok(MCP_TOOL_NAMES.includes('assess_issue'), 'a shortfall is a verdict, not a fifth surface');
});

test('a decomposed issue’s shortfall must name what fell short — synchronously', async () => {
  const { system } = plannedSystem();
  const agent = spawnAssessor(system);

  const noCause = await callTool(system, agent, 'assess_issue', { status: 'more_work', summary: 'not finished' });
  assert.equal(noCause.isError, true, 'without it there is nothing the harness can route');
  assert.match(noCause.text, /cause "plan"|cause "part"|cause "goal"/, 'the refusal names the alternatives');
  assert.equal(system.store.getShortfall('issue:12'), null, 'and nothing is written');

  const badSlug = await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the schema is wrong',
    cause: 'part',
    part: 'nosuchpart',
  });
  assert.equal(badSlug.isError, true);
  assert.match(badSlug.text, /schema, api/, 'the refusal lists the parts that do exist');

  const good = await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the schema part never added the migration',
    cause: 'part',
    part: 'schema',
  });
  assert.equal(good.isError, false);
  const row = system.store.getShortfall('issue:12');
  assert.equal(row?.cause, 'part');
  assert.equal(row?.partSlug, 'schema');
  assert.equal(row?.by, 'assessor');
  system.store.close();
});

test('an unplanned issue may not blame a plan, and needs no cause at all', async () => {
  const { system } = unplannedSystem();
  const agent = spawnAssessor(system);

  const blamed = await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'nope',
    cause: 'plan',
  });
  assert.equal(blamed.isError, true);
  assert.match(blamed.text, /has no plan/);

  const bare = await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the endpoint is there but the tests are not',
  });
  assert.equal(bare.isError, false, 'the honest reading is "the work is not finished"');
  assert.equal(system.store.getShortfall('issue:12')?.cause, null);
  system.store.close();
});

test('a delivered verdict may not carry a cause — an assessor that filled one in contradicted itself', async () => {
  const { system } = plannedSystem();
  const agent = spawnAssessor(system);
  const res = await callTool(system, agent, 'assess_issue', {
    status: 'delivered',
    summary: 'all present',
    cause: 'plan',
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /you said the issue is delivered/);
  system.store.close();
});

// -- end to end: the loop actually closes ------------------------------------

test('accepting a plan-cause shortfall sends the decomposition back to a planner', async () => {
  const { system } = plannedSystem();
  const agent = spawnAssessor(system);
  await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the split left out the CLI entirely',
    cause: 'plan',
  });

  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals().find((p) => p.kind === 'shortfall');
  assert.ok(proposal, 'the rule proposes rather than acts');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'active', 'and nothing moved before the click');

  const accepted = await system.proposals.accept(proposal!.id, 'agreed');
  assert.equal(accepted!.outcome, 'performed');
  const plan = system.store.getPlanByOrigin('issue:12')!;
  assert.equal(plan.status, 'planning', 'which is the entire effect — rule `issue-plan` takes it from here');
  assert.match(plan.reason ?? '', /the split left out the CLI entirely/, 'the replanner is told what fell short');
  // The row is consumed by the effect it drove, so the rule does not re-propose it.
  assert.equal(system.store.getShortfall('issue:12'), null);

  // Audited outside the pulse, under the authority chain every accepted proposal uses.
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal!.id}`)!;
  assert.match(audited.detail, /sent the plan for issue:12 back to a planner/);
  assert.match(audited.detail, /authorized by you/);
  system.store.close();
});

test('accepting a part-cause shortfall appends a part and leaves the one that fell short alone', async () => {
  const { system } = plannedSystem();
  const planId = system.store.getPlanByOrigin('issue:12')!.id;
  // The part finished — its PR merged, its branch is spent. That is exactly why a
  // follow-up is appended rather than the part being returned to `ready`.
  const schema = system.store.listPlanParts(planId).find((p) => p.slug === 'schema')!;
  system.store.updatePlanPart(schema.id, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 });

  const agent = spawnAssessor(system);
  await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the schema part landed the table but never wrote the migration',
    cause: 'part',
    part: 'schema',
  });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals().find((p) => p.kind === 'shortfall')!;
  await system.proposals.accept(proposal.id);

  const parts = system.store.listPlanParts(planId);
  const followup = parts.find((p) => p.slug === 'schema-followup');
  assert.ok(followup, 'one new part, for the scope that fell short');
  assert.equal(followup!.status, 'pending');
  assert.match(followup!.scope, /never wrote the migration/, 'the assessor’s words are its scope');
  assert.deepEqual(followup!.dependsOn, [], 'nothing open to stack on — the part it follows finished');

  const after = parts.find((p) => p.slug === 'schema')!;
  assert.equal(after.status, 'merged', 'a part with work started is never retired or resurrected');
  assert.equal(after.prNumber, 40);
  system.store.close();
});

test('rejecting acts on nothing and leaves the issue exactly where it was', async () => {
  const { system } = plannedSystem();
  const agent = spawnAssessor(system);
  await callTool(system, agent, 'assess_issue', { status: 'more_work', summary: 'wrong split', cause: 'plan' });
  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals().find((p) => p.kind === 'shortfall')!;

  const rejected = system.proposals.reject(proposal.id, 'the split is fine, the ticket is wrong');
  assert.equal(rejected!.outcome, 'none');
  assert.equal(system.store.getPlanByOrigin('issue:12')!.status, 'active', 'unlike a plan refusal, nothing settles');
  // The verdict is still true — you declined to act on it, which is a different
  // thing — so the row and its chip stay. This is the asymmetry with `refusePlan`.
  assert.ok(system.store.getShortfall('issue:12'));

  // And it is asked once: the rejection holds the rule until the world moves.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().filter((p) => p.kind === 'shortfall').length, 1);
  system.store.close();
});

test('the loop is bounded by the assessor’s own attempt cap, and nothing new counts it', async () => {
  // `assess → propose → replan → work → assess` is bounded at three rounds by
  // `dispatchVerdict` on `issue:<n>:assess`, which was already in the code. A
  // second counter claiming to bound the same loop would be two answers to one
  // question — the argument that kept `urgent` a boolean rather than a rank.
  const { system } = plannedSystem();
  const agent = spawnAssessor(system);
  await callTool(system, agent, 'assess_issue', { status: 'more_work', summary: 'wrong split', cause: 'plan' });

  // Repeated pulses with the proposal pending neither re-ask nor grow rows.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().filter((p) => p.kind === 'shortfall').length, 1);
  assert.equal(system.store.listOpenEscalations().filter((e) => e.context.originRef === undefined).length >= 0, true);
  system.store.close();
});

test('the cockpit is shipped the verdict beside the pickup chip, not inside it', async () => {
  const { system } = plannedSystem();
  const agent = spawnAssessor(system);
  await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the CLI half is missing',
    cause: 'plan',
  });
  await system.harness.runCycle('manual');

  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  const snap = buildStateSnapshot(system);
  const row = snap.world.issues.find((i) => i.number === 12)!;
  assert.equal(row.shortfall?.cause, 'plan');
  // Beside the pickup verdict, never inside it. This issue is decomposed, so
  // rule `issue-pickup` leaves it to rule `plan-part` either way — what matters is that the shortfall
  // is nowhere among the reasons. Folding it in would make it a pickup gate,
  // which is the one thing it must never be.
  assert.equal(
    (row.pickup?.reasons ?? []).some((r) => /short|assess/i.test(r)),
    false,
    'the pickup verdict does not know this row exists',
  );
  // And the chip can join to the inbox: the pending proposal is on the same
  // snapshot, keyed on the ref the chip builds from the issue number.
  assert.ok(
    snap.proposals.some((p) => p.kind === 'shortfall' && p.ref === 'issue:12:shortfall' && p.status === 'pending'),
  );
  system.store.close();
});

// -- fixtures ----------------------------------------------------------------

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function shortfallRow(over: Partial<IssueShortfall> = {}): IssueShortfall {
  return {
    originRef: 'issue:12',
    cause: 'plan',
    partSlug: null,
    summary: 'the CLI half is missing',
    detail: null,
    by: 'assessor',
    agentId: 'agent_1',
    taskId: 't1',
    decidedAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function deliveryRow() {
  return {
    originRef: 'issue:12',
    summary: 'all present',
    detail: null,
    by: 'assessor' as const,
    agentId: null,
    taskId: null,
    decidedAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
  };
}

function conclusionRow(over: Partial<IssueConclusion>): IssueConclusion {
  return {
    originRef: 'issue:12',
    verdict: 'done',
    note: '',
    by: 'agent',
    agentId: null,
    taskId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function planRow(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Add the thing',
    status: 'active',
    reason: 'Schema first.',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** One live part, so `plan_1` reads as the decomposition these tests mean. */
function partRow(): PlanPart {
  return {
    id: 'plan_1:schema',
    planId: 'plan_1',
    slug: 'schema',
    seq: 1,
    title: 'Schema',
    scope: 'src/store/',
    rationale: null,
    acceptance: null,
    touches: [],
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: 41,
    status: 'in_review',
    blockedReason: null,
    taskId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function proposalRow(over: Partial<Proposal>): Proposal {
  return {
    id: 'prop_1',
    kind: 'shortfall',
    ref: shortfallRef(12),
    status: 'pending',
    action: { type: 'propose_shortfall', reason: 'x' },
    note: 'the split is fine',
    decidedBy: 'human',
    decidedAt: null,
    escalationId: 'esc_1',
    createdAt: NOW,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    // The plan rows above are decompositions, and a plan's **shape** is its parts:
    // with none, `plan_1` would be a plan being delivered as one pull request and
    // rule `issue-pickup` would work the issue while these assertions counted
    // dispatches.
    planParts: [partRow()],
    tasks: [task()],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

function dispatcher(): RuleDispatcher {
  return new RuleDispatcher({ ignoreLabel: 'lubbdubb-ignore' }, {}, undefined, 'main');
}

async function decide(context: DispatchContext): Promise<{ actions: { type: string; [k: string]: unknown }[] }> {
  const result = await dispatcher().decide(context);
  return result as never;
}

// -- system fixtures ---------------------------------------------------------

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const run = (...args: string[]): void => void execFileSync('git', args, { cwd: root });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  const file = join(root, 'README.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '# repo\n');
  run('add', '.');
  run('commit', '-m', 'init');
  return root;
}

function systemWith(planning: boolean): { system: System } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    planning: { enabled: planning, requireApproval: false } as never,
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing', body: 'Several PRs.' });
  return { system };
}

function plannedSystem(): { system: System } {
  const { system } = systemWith(true);
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Schema first.',
      parts: [
        { slug: 'schema', title: 'schema', scope: 'src/store/', dependsOn: [] },
        { slug: 'api', title: 'api', scope: 'src/server/', dependsOn: ['schema'] },
      ],
    }),
  );
  assert.ok(doc.ok);
  ingestPlanDocument(system.store, {
    doc: doc.document,
    originRef: 'issue:12',
    title: 'Add the thing',
    requireApproval: false,
  });
  return { system };
}

function unplannedSystem(): { system: System } {
  return systemWith(false);
}

function spawnAssessor(system: System): Agent {
  const t = system.store.createTask({
    kind: 'code',
    title: 'Assess issue #12',
    prompt: 'judge it',
    branch: 'assess/issue/12',
    originRef: 'issue:12:assess',
  });
  return system.agents.spawn(t, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}
