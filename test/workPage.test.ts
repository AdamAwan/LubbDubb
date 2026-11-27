import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewModel, type CockpitView } from '../web/src/view/viewModel.js';
import type { OpenPullRequest, PlanPart } from '../web/src/types.js';
import { withAsks } from './support/asks.js';
import { buildFixtureState } from './support/cockpitFixtures.js';
import {
  byFeature,
  goalsOfWork,
  inFlight,
  laterStages,
  NO_GOAL,
  prReading,
  workParts,
  type GoalWork,
} from '../web/src/view/workPage.js';
import { goalInChat, inChat } from '../web/src/view/needsYouPage.js';
import { buildGoalPage } from '../web/src/view/goalPage.js';
import { OVERVIEW_IN_FLIGHT, WORK_IN_FLIGHT } from '../web/src/view/pickup.js';

type State = CockpitView['state'];

function view(mutate: (state: State) => void = () => {}): CockpitView {
  const state = buildFixtureState();
  mutate(state);
  return buildViewModel({
    state: withAsks(state),
    now: Date.now(),
    connected: true,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: null,
    consolePanel: null,
    tab: 'inflight',
  });
}

const goal = (goals: readonly GoalWork[], ref: string): GoalWork => {
  const work = goals.find((g) => g.ref === ref);
  assert.ok(work, `no row for ${ref}`);
  return work;
};

function work(over: Partial<GoalWork> & { ref: string }): GoalWork {
  return { issue: undefined, parts: [], asks: [], prs: [], agents: [], holds: [], stages: [], ...over };
}

test('goals of work: a prioritised goal first, then those with a pressing ask, then other asks, then the rest; no goal last', () => {
  const goals = goalsOfWork(view());
  assert.equal(goals[0]?.ref, 'issue:390', 'the prioritised goal leads');
  assert.equal(goals[goals.length - 1]?.ref, NO_GOAL, 'the ticketless row is last');
  const rank = (w: GoalWork): number =>
    w.ref === NO_GOAL
      ? 4
      : w.issue?.priority != null
        ? 0
        : w.asks.some((a) => a.urgency === 'now')
          ? 1
          : w.asks.length > 0
            ? 2
            : 3;
  const ranks = goals.map(rank);
  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => a - b),
    'rows are in urgency order',
  );
});

test('goals of work: every goal with a pull request open is a row, and the row carries its plan’s live parts in order', () => {
  const v = view();
  const goals = goalsOfWork(v);
  const prs = goals.flatMap((g) => g.prs.map((pr) => pr.number)).sort((a, b) => a - b);
  assert.deepEqual(
    prs,
    v.state.world.pullRequests.map((pr) => pr.number).sort((a, b) => a - b),
    'every open PR lands on exactly one row',
  );
  const parts = goal(goals, 'issue:390').parts;
  assert.ok(parts.length > 0);
  assert.ok(parts.every((p) => p.status !== 'retired'));
  assert.deepEqual(
    parts.map((p) => p.seq),
    [...parts.map((p) => p.seq)].sort((a, b) => a - b),
  );
});

test('in flight: by pickup status, or by an open pull request or a live agent whatever the status says', () => {
  const issue = (status: string) => ({ number: 1, pickup: { status } }) as unknown as NonNullable<GoalWork['issue']>;
  assert.equal(inFlight(work({ ref: NO_GOAL })), true);
  assert.equal(inFlight(work({ ref: 'issue:1', issue: issue('parked') })), true, 'parked is held, not done');
  assert.equal(inFlight(work({ ref: 'issue:1', issue: issue('escalated') })), true);
  assert.equal(inFlight(work({ ref: 'issue:1', issue: issue('delivered') })), false);
  assert.equal(inFlight(work({ ref: 'issue:1', issue: issue('appraisal') })), false);
  assert.equal(
    inFlight(work({ ref: 'issue:1', issue: issue('delivered'), prs: [{ number: 9 } as OpenPullRequest] })),
    true,
  );
});

test('the Work tab’s in-flight set and the overview’s differ in exactly parked, escalated and delivered', () => {
  const only = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].filter((s) => !b.has(s)).sort();
  assert.deepEqual(only(WORK_IN_FLIGHT, OVERVIEW_IN_FLIGHT), ['escalated', 'parked']);
  assert.deepEqual(only(OVERVIEW_IN_FLIGHT, WORK_IN_FLIGHT), ['delivered']);
});

test('by feature: goals grouped under their parent in first-seen order, each one under none on its own', () => {
  const under = (n: number | null, ref: string): GoalWork =>
    work({
      ref,
      issue: { parent: n === null ? null : { number: n, title: `F${n}` } } as unknown as GoalWork['issue'],
    });
  const { features, loose } = byFeature([
    under(null, 'a'),
    under(7, 'b'),
    under(3, 'c'),
    under(7, 'd'),
    under(null, 'e'),
  ]);
  assert.deepEqual(
    features.map((g) => [g.number, g.title, g.goals.map((w) => w.ref)]),
    [
      [7, 'F7', ['b', 'd']],
      [3, 'F3', ['c']],
    ],
  );
  assert.deepEqual(
    loose.map((w) => w.ref),
    ['a', 'e'],
  );
});

test('holds: asks, a blocked part flagged as a part, the stack hold once per stack, and the queue’s reason quoted', () => {
  const v = view();
  const goals = goalsOfWork(v);
  const g390 = goal(goals, 'issue:390');
  const part = g390.holds.filter((h) => h.part);
  assert.equal(part.length, 1);
  assert.match(part[0]!.text, /^part “cutover”: /);
  assert.ok(g390.holds.some((h) => h.tone === 'ask'));
  for (const g of goals) {
    const texts = g.holds.map((h) => h.text);
    assert.equal(new Set(texts).size, texts.length, `${g.ref} says a hold twice`);
  }
  const g368 = goal(goals, 'issue:368');
  assert.equal(g368.prs.length, 2, 'the fixtures stack two PRs on #368');
  assert.equal(g368.holds.filter((h) => h.text.startsWith('stack can’t land')).length, 1);
  const queued = v.upNext.find((item) => item.status !== 'dispatching' && item.origin.startsWith('issue:333'));
  assert.ok(queued, 'the fixtures hold work for #333 in the queue');
  assert.ok(goal(goals, 'issue:333').holds.some((h) => h.text === queued.reason));
});

test('a pull request reads why it is on the operator as Needs you says it, then a red build, then its own reason', () => {
  const base = {
    number: 1,
    ciStatus: 'passing',
    unresolvedComments: [],
    attention: { status: 'agent', reasons: ['waiting on review'] },
  } as unknown as OpenPullRequest;
  assert.deepEqual(prReading({ ...base, attention: { ...base.attention, status: 'you' } }), {
    text: 'Your call',
    tone: 'ask',
  });
  assert.deepEqual(prReading({ ...base, ciStatus: 'failing' }), { text: 'CI failing', tone: 'hold' });
  assert.deepEqual(prReading(base), { text: 'waiting on review', tone: 'quiet' });
});

test('work parts: each part with its pull request, a mark and a tone', () => {
  const p = (slug: string, status: PlanPart['status'], prNumber: number | null = null): PlanPart =>
    ({ id: slug, slug, seq: 1, status, prNumber, blockedReason: null }) as unknown as PlanPart;
  const pr = { number: 5, ciStatus: 'failing', unresolvedComments: [], attention: { status: 'agent', reasons: [] } };
  const rows = workParts(
    [p('a', 'merged'), p('b', 'blocked'), p('c', 'dispatched', 5), p('d', 'pending')],
    [pr as unknown as OpenPullRequest],
  );
  assert.deepEqual(
    rows.map((r) => [r.part.slug, r.mark, r.tone, r.pr?.number ?? null]),
    [
      ['a', '✓', 'done', null],
      ['b', '⏸', 'hold', null],
      ['c', '▶', 'hold', 5],
      ['d', '', 'quiet', null],
    ],
  );
});

test('later stages: only the stages with something to say', () => {
  const v = view();
  const page = buildGoalPage(v.state, 'issue:395', v.needsYou, null);
  assert.ok(page);
  const stages = laterStages(page);
  assert.ok(stages.length > 0);
  assert.ok(stages.every((s) => s.stage.tone !== 'grey'));
  assert.deepEqual(
    stages.map((s) => s.name),
    ['Validate', 'Close', 'Watch'].filter((n) => stages.some((s) => s.name === n)),
    'in their order on the goal',
  );
});

test('in chat: the item the chat is on, or one sent and not yet done; a goal is in chat if any of its items is', () => {
  const listener = {
    state: 'busy',
    on: { kind: 'pr', number: 413 },
    queued: 1,
    sent: [{ item: { kind: 'ask', id: 'esc-1' }, sentAt: '2026-11-27T00:00:00.000Z' }],
  } as const;
  const l = listener as unknown as CockpitView['state']['listener'];
  assert.equal(inChat(l, { kind: 'pr', number: 413 }), true);
  assert.equal(inChat(l, { kind: 'ask', id: 'esc-1' }), true);
  assert.equal(inChat(l, { kind: 'pr', number: 414 }), false);
  assert.equal(inChat(l, { kind: 'ask', id: 'esc-2' }), false);
  assert.equal(goalInChat(l, { asks: [], prs: [{ number: 414 }, { number: 413 }] }), true);
  assert.equal(goalInChat(l, { asks: [{ id: 'esc-1' }], prs: [] }), true);
  assert.equal(goalInChat(l, { asks: [{ id: 'esc-3' }], prs: [{ number: 1 }] }), false);
});

test('an ask raised on no goal is on the No goal row', () => {
  const v = view();
  const loose = v.needsYou.filter((row) => row.goalRef === null);
  assert.ok(loose.length > 0, 'the fixtures carry an ask on no goal');
  const none = goalsOfWork(v).find((g) => g.ref === NO_GOAL);
  assert.ok(none);
  assert.deepEqual(none.asks.map((a) => a.id).sort(), loose.map((a) => a.id).sort());
});

test('stages: five per goal in order, Plan approved for an active plan, Build reading its parts; none on the No goal row', () => {
  const goals = goalsOfWork(view());
  const row = goal(goals, 'issue:390');
  assert.deepEqual(
    row.stages.map((s) => s.name),
    ['Plan', 'Build', 'Validate', 'Close', 'Watch'],
  );
  assert.equal(row.stages[0]?.stage.reading, 'approved');
  assert.match(row.stages[1]?.count ?? '', /^\d+\/\d+$/);
  const build = row.stages[1]?.stage;
  assert.ok(build);
  const merged = row.parts.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
  assert.ok(build.done !== null && Math.abs(build.done - (merged / row.parts.length) * 100) < 1e-9);
  assert.deepEqual(goal(goals, NO_GOAL).stages, []);
});

test('stages: a plan awaiting approval reads amber on Plan', () => {
  const goals = goalsOfWork(
    view((s) => {
      const plan = s.plans?.find((p) => p.originRef === 'issue:390');
      assert.ok(plan);
      plan.status = 'awaiting_approval';
    }),
  );
  const plan = goal(goals, 'issue:390').stages[0]?.stage;
  assert.equal(plan?.tone, 'amber');
});
