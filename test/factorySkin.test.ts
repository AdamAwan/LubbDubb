import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { Decision, Issue, Plan, PlanPart, PullRequest, QueueItem, WorldEvent } from '../web/src/types.js';

// Same reason as `cockpitSkins.test.ts`: Vite compiles the cockpit's JSX with the
// automatic runtime and `tsx` with the classic one, so the global goes in before
// the skin modules are pulled in.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { resolveSkin } = await import('../web/src/skins/registry.js');
const {
  assayStatus,
  assemblerStatus,
  bayMachineStatus,
  botState,
  clip,
  crateMachineStatus,
  furnaceStatus,
  iconForEventKind,
  iconForOrigin,
  iconForStage,
  inserterPhase,
  launchStatus,
  manifestStatus,
  patchStatus,
  prMachineStatus,
  satelliteStatus,
  scannerStatus,
  signalPolarity,
  signalPostStatus,
  siloStatus,
  toneColor,
  returnRoute,
} = await import('../web/src/skins/factory/vocabulary.js');
const { buildGoalFloor, floorFixtures, floorGoals, layoutFloor, partProgress } = await import(
  '../web/src/skins/factory/goalFloor.js'
);
const { GoalFloor } = await import('../web/src/skins/factory/components/GoalFloor.js');
const { BlueprintDesk, FaultLog, FindingsDesk } = await import('../web/src/skins/factory/components/Desks.js');
const { ladderFor, loadedCount, mergeGates, prCourt, rack, rackGroup } = await import(
  '../web/src/skins/factory/inspection.js'
);
const { Inspection } = await import('../web/src/skins/factory/components/Inspection.js');
const { axisScale, productionReading } = await import('../web/src/skins/factory/production.js');
const { accumulatorCells } = await import('../web/src/skins/factory/power.js');

const INERT = new Proxy({} as CockpitActions, { get: () => () => Promise.resolve() });

// ---- Goal Floor fixtures -------------------------------------------------
//
// Built by hand rather than mutated out of the demo world, because the point of
// most of these assertions is a *state combination* the demo does not contain —
// a refused assay, a delivered goal with its tail, a shortfall.
const NOW = '2026-01-01T00:00:00.000Z';

const PLAN: Plan = {
  id: 'plan-9',
  originRef: 'issue:9',
  title: 'A goal',
  status: 'active',
  reason: null,
  risks: null,
  outOfScope: null,
  document: null,
  discussing: false,
  statusCommentRef: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function planPart(slug: string, dependsOn: string[], status: string, seq: number): PlanPart {
  return {
    id: `p-${slug}`,
    planId: 'plan-9',
    slug,
    seq,
    title: slug,
    scope: 'src/',
    dependsOn,
    rationale: null,
    acceptance: null,
    branch: null,
    prNumber: null,
    status,
    taskId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function floorInput(over: {
  plan?: Plan | null;
  parts?: PlanPart[];
  openPrs?: PullRequest[];
  pickup?: string;
  pickupReasons?: string[];
  workItemState?: string;
  linkedPrNumber?: number;
  assay?: Issue['assay'];
  conclusion?: Issue['conclusion'];
  shortfall?: Issue['shortfall'];
  delivery?: Issue['delivery'];
}) {
  const issue: Issue = {
    id: 'iss-9',
    number: 9,
    title: 'A goal',
    body: '',
    labels: [],
    state: 'open',
    workItemState: over.workItemState,
    linkedPrNumber: over.linkedPrNumber ?? null,
    pickup: { eligible: false, status: over.pickup ?? 'planning', reasons: over.pickupReasons ?? [] },
    assay: over.assay ?? null,
    conclusion: over.conclusion,
    shortfall: over.shortfall ?? null,
    delivery: over.delivery ?? null,
  };
  return {
    issue,
    plan: over.plan === undefined ? PLAN : over.plan,
    parts: over.parts ?? [],
    openPrs: over.openPrs ?? [],
    closedPrs: [],
    tasks: [],
    upcoming: [],
    recorded: [],
  };
}

function render(
  mutate?: (s: ReturnType<typeof buildDemoState>['state']) => void,
  demo = true,
  connected = true,
): string {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { state } = buildDemoState();
    mutate?.(state);
    const view = buildViewModel({
      state,
      now,
      connected,
      demo,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: now,
      viewingPlan: null,
      settingsOpen: false,
    });
    return renderToStaticMarkup(createElement(resolveSkin('factory').Root, { view, actions: INERT }));
  } finally {
    Date.now = realNow;
  }
}

/**
 * The same, for a desk that opens from a status-bar gauge rather than sitting in a
 * rail. `renderToStaticMarkup` cannot click, so a panel behind a modal is
 * unreachable through `render()` — which is the reason the three desks are
 * components and not JSX inlined into `FactoryRoot`.
 */
function renderDesk(
  Desk: (props: { view: CockpitView; actions: CockpitActions }) => JSX.Element,
  mutate?: (s: ReturnType<typeof buildDemoState>['state']) => void,
  demo = true,
): string {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { state } = buildDemoState();
    mutate?.(state);
    const view = buildViewModel({
      state,
      now,
      connected: true,
      demo,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: now,
      viewingPlan: null,
      settingsOpen: false,
    });
    return renderToStaticMarkup(createElement(Desk, { view, actions: INERT }));
  } finally {
    Date.now = realNow;
  }
}

/**
 * The vocabulary is stated once so the belt and the bay can't disagree about
 * what a part looks like. These are the cases where a naive prefix check gets it
 * wrong: a plan and a part are both `issue:`-prefixed, and a job is not.
 */
test('every origin shape maps to one machine', () => {
  assert.equal(iconForOrigin('pr:42:ci'), 'gear');
  assert.equal(iconForOrigin('issue:12:plan'), 'blueprint');
  assert.equal(iconForOrigin('issue:12:part:api'), 'assembler');
  assert.equal(iconForOrigin('issue:12'), 'flask');
  assert.equal(iconForOrigin('story:st-9:work'), 'flask');
  assert.equal(iconForOrigin('job:7'), 'chest');
  assert.equal(iconForOrigin(null), 'chest');
});

/** Every `QueueItem.status` has a crate label; a new one must not render blank. */
test('every queue status has a machine status', () => {
  const statuses: QueueItem['status'][] = ['dispatching', 'waiting', 'cooldown', 'capped', 'unapproved'];
  for (const status of statuses) {
    const machine = crateMachineStatus({ status } as QueueItem, false);
    assert.ok(machine.word.length > 0, `${status} rendered no word`);
  }
});

/**
 * The two `waiting`s are different facts and the whole reason both halves of the
 * floor route through one file. An *agent* that is waiting is parked on a human
 * — the one red thing here — while an *item* that is waiting merely has no free
 * bay, which is the harness working exactly as intended.
 */
test('a waiting agent and a waiting item do not read alike', () => {
  const agent = bayMachineStatus({ status: 'waiting' } as never, false);
  const item = crateMachineStatus({ status: 'waiting' } as QueueItem, false);
  assert.equal(agent.tone, 'bad');
  assert.equal(item.tone, 'idle');
  assert.notEqual(agent.word, item.word);
});

/** No power outranks every other diagnosis: nothing else explains the whole floor. */
test('a paused floor says so before anything else', () => {
  assert.equal(bayMachineStatus({ status: 'running' } as never, true).word, 'No power');
  assert.equal(crateMachineStatus({ status: 'dispatching' } as QueueItem, true).word, 'No power');
});

/**
 * An inserter swings on a transfer. Occupancy is what it used to mean, and an
 * arm that swings for the whole life of an agent is the one moving thing on the
 * floor carrying no information.
 */
test('an inserter swings for a dispatch, not for an occupied bay', () => {
  const interval = 60_000;
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const at = (ms: number) => ({ status: 'running', startedAt: new Date(now - ms).toISOString() }) as never;

  assert.equal(inserterPhase(at(5_000), now, interval), 'transfer', 'a fresh dispatch must move the arm');
  assert.equal(inserterPhase(at(600_000), now, interval), 'rest', 'a long-running agent must not keep swinging');
  assert.equal(inserterPhase(null, now, interval), 'off');
  // Parked on a human: the bay is staffed, but nothing is being moved.
  assert.equal(
    inserterPhase({ status: 'waiting', startedAt: new Date(now).toISOString() } as never, now, interval),
    'rest',
  );
});

/**
 * Polarity comes from the event kind and never from its summary — parsing prose
 * written for a human would be a second reader of a string nobody promised to
 * keep stable. `pr_ci` genuinely does not say which way CI went.
 */
test('signal polarity is read from the kind, and guesses nothing', () => {
  assert.equal(signalPolarity('pr_merged'), 'up');
  assert.equal(signalPolarity('pr_approved'), 'up');
  assert.equal(signalPolarity('pr_closed'), 'down');
  assert.equal(signalPolarity('pr_ci'), 'neutral');
  assert.equal(signalPolarity('pr_comment'), 'neutral');
});

/** Red means one thing on this floor: parked on a question only you can answer. */
test('only a waiting agent reads as jammed', () => {
  assert.equal(botState({ status: 'waiting' } as never), 'idle');
  assert.equal(botState({ status: 'running' } as never), 'working');
  assert.equal(botState({ status: 'starting' } as never), 'working');
  assert.equal(botState({ status: 'done' } as never), 'spent');
  assert.equal(botState({ status: 'failed' } as never), 'spent');
});

test('clip leaves short text alone and marks what it cut', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('a much longer string', 10), 'a much lo…');
});

/**
 * The belt is the harness running. A paused or held cockpit must stop it — a belt
 * still moving while no cycle will run is the one genuinely misleading thing this
 * layout could draw, so it is asserted rather than left to the CSS being right.
 */
test('the belt stops when the harness will not pulse', () => {
  assert.ok(!/fx-belt stopped/.test(render()), 'a running harness should not stop the belt');
  assert.ok(/fx-belt stopped/.test(render((s) => (s.control.paused = true))), 'paused must stop the belt');
  assert.ok(
    /fx-belt stopped/.test(
      render((s) => {
        s.recovery = [
          {
            agentId: 'a',
            taskId: 't',
            title: 'x',
            kind: 'code',
            originRef: null,
            branch: null,
            cwd: '/tmp',
            died: 'crashed',
            waitingReason: null,
            note: null,
            startedAt: new Date().toISOString(),
            detectedAt: null,
            restorable: false,
            restoreBlocked: 'no session id',
          },
        ];
      }),
    ),
    'a recovery hold must stop the belt',
  );
});

/**
 * The gate *is* the headroom cut: it sits after the dispatching prefix, so an
 * item drawn to its left is one the harness said it is starting this cycle. If
 * the two ever came apart the picture would be confidently wrong, which is worse
 * than no picture.
 */
test('the gate sits after the dispatching prefix', () => {
  const item = (origin: string, status: QueueItem['status']): QueueItem => ({
    origin,
    rule: 'issue-pickup',
    title: origin,
    kind: 'code',
    branch: null,
    status,
    reason: 'because',
  });
  const gateLeft = (markup: string) => {
    const m = /class="fx-gate" style="left:(\d+)px"/.exec(markup);
    assert.ok(m, 'no gate rendered');
    return Number(m[1]);
  };

  const none = render((s) => {
    s.upcoming = { cycleId: 'c', at: new Date().toISOString(), items: [item('issue:1', 'waiting')] };
  });
  const two = render((s) => {
    s.upcoming = {
      cycleId: 'c',
      at: new Date().toISOString(),
      items: [item('issue:1', 'dispatching'), item('issue:2', 'dispatching'), item('issue:3', 'waiting')],
    };
  });

  assert.ok(gateLeft(two) > gateLeft(none), 'the gate must move right as more items dispatch');
  // Two crates of pitch 140 between them, exactly.
  assert.equal(gateLeft(two) - gateLeft(none), 280);
});

/** The queue reaches the belt at all — the panel this skin exists to replace. */
test('the belt carries the dispatcher plan', () => {
  const markup = render();
  assert.match(markup, /issue:208/, 'the top candidate is missing from the belt');
  assert.match(markup, /Output backed up/, 'a capped item must say so rather than look merely queued');
});

/**
 * The belt splits at the cut, and everything behind it butts together. Two runs
 * rather than one row is what draws compression at all — and each is omitted
 * when empty, because an empty flex child still takes the row's gap and that gap
 * is exactly where the gate sits.
 */
test('the belt compresses behind the cut', () => {
  const markup = render();
  assert.match(markup, /fx-belt-run moving/, 'the boarding prefix must be its own run');
  assert.match(markup, /fx-belt-run jam/, 'the backed-up remainder must be its own run');

  const allBoarding = render((s) => {
    for (const item of s.upcoming?.items ?? []) item.status = 'dispatching';
  });
  assert.doesNotMatch(allBoarding, /fx-belt-run jam/, 'nothing backed up must render no jam run');
  assert.doesNotMatch(allBoarding, /fx-jam-tag/, 'nothing backed up must not claim a backlog');
});

/**
 * The floor is laid out from the cap. The old fixed four slots named the surplus
 * in the header and cropped it off the picture, which made the one control an
 * operator actually turns invisible in the panel that exists to show it.
 */
test('raising the cap widens the floor', () => {
  const widthOf = (markup: string) => {
    // The plan's width is a custom property the CSS takes as a *minimum*, so the
    // floor and the belt still fill a panel wider than the plan. Pinned as the
    // element's `width`, a one-bay plan ended mid-panel and left the belt hanging.
    const m = /class="fx-line fx-sunk" style="--fx-plan-w:(\d+)px"/.exec(markup);
    assert.ok(m, 'the floor rendered no plan width');
    assert.doesNotMatch(markup, /class="fx-line fx-sunk" style="[^"]*[^-]width:/, 'the floor must not pin its width');
    return Number(m[1]);
  };
  const small = widthOf(render((s) => (s.control.cap = 2)));
  const large = widthOf(render((s) => (s.control.cap = 5)));
  assert.ok(large > small, 'a higher cap must draw more bays');

  // Bounded, or the plan is wider than any screen: past the limit the surplus is
  // named in the header exactly as every bay past the fourth used to be.
  const huge = widthOf(render((s) => (s.control.cap = 40)));
  const atLimit = widthOf(render((s) => (s.control.cap = 8)));
  assert.equal(huge, atLimit, 'the drawn floor must stop growing at the bay limit');
});

/**
 * Injection fakes a world change, which only the static demo has any use for: a
 * real run against a fake provider is still a real run, and a panel that lies to
 * the harness there is a way to lie to yourself about what it is reacting to. The
 * empty-floor line reads the same predicate, so it never offers an injection there
 * is no panel for.
 */
test('injection is a demo control, not a provider one', () => {
  const demo = renderDesk(BlueprintDesk, (s) => (s.config.injectable = true));
  assert.match(demo, /class="inject"/, 'the demo build must keep the inject panel');

  // `injectable` still true — a fake provider is configured — and still no panel.
  const real = renderDesk(BlueprintDesk, (s) => (s.config.injectable = true), false);
  assert.doesNotMatch(real, /class="inject"/, 'a real run must not offer injection');
  assert.doesNotMatch(real, /Inject event/, 'nor its label');

  const idle = render((s) => {
    s.agents = [];
    s.config.injectable = true;
  }, false);
  assert.match(idle, /waiting for the world to change/, 'the empty floor must not offer a panel that is gone');
});

/**
 * The desks are behind a gauge, so the *way in* is the thing that can now go
 * missing — and a count nothing can open is the dead `see the fault log at the
 * foot of the floor` line this replaced. Each gauge is asserted to be a real
 * button, and Faults is asserted to stay one at zero: it is the only way to the
 * log, which carries the clear.
 */
test('every desk has a way in from the status bar', () => {
  const markup = render();
  for (const label of ['Alerts', 'Faults', 'Findings', 'Queued', 'Output']) {
    assert.match(
      markup,
      new RegExp(`<button[^>]*class="fx-read fx-act[^"]*"[^>]*>(?:(?!</button>).)*${label}`, 's'),
      `${label} must be a button in the bar`,
    );
  }

  // The rail is gone: nothing may still be placed as a panel.
  assert.doesNotMatch(markup, /data-fx="stamp"/, 'the stamp desk must not also be a panel');
  assert.doesNotMatch(markup, /data-fx="faults"/, 'the fault log must not also be a panel');
  assert.doesNotMatch(markup, /data-fx="blueprints"/, 'the blueprint desk must not also be a panel');
  assert.doesNotMatch(markup, /data-fx="off-blueprint"/, 'the findings desk must not also be a panel');
  assert.doesNotMatch(markup, /fx-rail-act/, 'the act rail must be gone');
  // Production went the same way, off the world rail rather than the act one:
  // its panel was a tile whose only content was a way in to the graph.
  assert.doesNotMatch(markup, /data-fx="production"/, 'the production graph must not also be a panel');

  const quiet = render((s) => {
    s.errors = [];
    s.escalations = [];
    s.jobs = [];
    s.findings = [];
    s.worldEvents = [];
  });
  assert.match(quiet, /class="fx-read fx-act quiet"/, 'a zero count must mute a gauge, not remove it');
  // Counted by the chevron rather than by `fx-act`: the scan gauge presses too
  // and wears the same face, and the chevron is the bar's one word for "there is
  // a panel behind this".
  assert.equal(
    (quiet.match(/class="fx-chev"/g) ?? []).length,
    5,
    'all five ways in must survive their counts being zero',
  );
  // Output's is the reading most likely to be zero — a floor that has merged
  // nothing in six hours is exactly when the graph is worth opening, since it
  // is the only place the spend rate and the truncation caveat are stated.
  assert.match(
    quiet,
    /class="fx-read fx-act fx-prod-read quiet"/,
    'a floor with no merges must mute the Output gauge, not remove the way to the graph',
  );
});

/** The number on a gauge's face, read off the markup rather than off the state. */
function gaugeCount(markup: string, label: string): string | undefined {
  const m = markup.match(new RegExp(`${label}</span><span class="fx-val[^"]*">(\\d+)`));
  assert.ok(m, `${label} must draw a count`);
  return m[1];
}

/**
 * The findings gauge counts what a *click resolves*, which is open findings
 * and nothing else. A promoted, filed or dismissed finding is done and a `filing`
 * one is decided, so neither is waiting on anyone; an overlap is diagnostic —
 * nothing here or in the harness actions one — so it can never light a gauge whose
 * whole claim is that pressing it leads to a decision. Asserted on the number
 * rather than on the markup that draws it, so the arrangement stays free.
 */
test('the findings gauge counts open findings, and only those', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const finding = (id: string, status: string) => ({
    id,
    agentId: 'agent-a1',
    taskId: 'task-a1',
    originRef: 'pr:142:ci',
    kind: 'out_of_scope' as const,
    ref: null,
    summary: `something ${id}`,
    status: status as 'open',
    jobId: null,
    ticketRef: null,
    createdAt: now,
    updatedAt: now,
  });

  const mixed = render((s) => {
    s.findings = [finding('f1', 'open'), finding('f2', 'dismissed'), finding('f3', 'filing'), finding('f4', 'filed')];
  });
  assert.equal(gaugeCount(mixed, 'Findings'), '1', 'only an open finding is unactioned');

  // Overlaps present, no findings: the gauge is muted, and the desk still lists
  // the overlap — it is the *count* they stay out of, not the panel.
  const overlapsOnly = render((s) => {
    s.findings = [];
  });
  assert.equal(gaugeCount(overlapsOnly, 'Findings'), '0', 'an overlap must not light the gauge');
  const desk = renderDesk(FindingsDesk, (s) => {
    s.findings = [];
  });
  assert.match(desk, /Two bots, one part/, 'the desk must still draw an overlap the gauge does not count');
  assert.match(desk, /restAzureDevOpsApi\.ts/, 'and the path both bots are writing');
});

/**
 * One subject, stated once. The bar had grown two pairs of duplicates — the fleet
 * as a Bots reading *and* as the `live/cap` inside the cap control, the pulse as a
 * countdown *and* as a "Run a scan" button at the far end — and a bar that says
 * everything twice is the one that runs out of room. Asserted on the number
 * itself rather than on the markup that draws it, so a later re-arrangement is
 * free and a re-introduced second copy is not.
 */
test('the fleet and the pulse are each one control in the bar', () => {
  const markup = render((s) => {
    s.control.cap = 3;
  });
  const bar = markup.slice(0, markup.indexOf('fx-grid'));

  assert.equal((bar.match(/2\/3|2<\/span>\s*<small>\/3/g) ?? []).length, 1, 'the fleet must be one reading in the bar');
  assert.match(bar, /class="fleet-control[^"]*"/, 'and it must be the one with the steppers on it');

  assert.match(
    bar,
    /<button[^>]*class="fx-read fx-act fx-run[^"]*"[^>]*>(?:(?!<\/button>).)*Scan/s,
    'the scan gauge must be the button that runs one',
  );
  assert.doesNotMatch(bar, /Run a scan/, 'so there must be no second button saying so');
});

/**
 * One grid, and the document order is the reading order. The rails are gone —
 * with them the independently scrolling columns — so placement is CSS alone, and
 * the two things this asserts are the two a later edit could quietly undo: that
 * every panel is a *direct child* of the one grid (a wrapper re-introduced round
 * any of them takes it out of the grid, and its span rule then does nothing), and
 * that Inspection and Bots are adjacent, which is what lets one row hold both.
 * Asserted on the markup rather than on a computed width, since `order` no longer
 * exists to rearrange it: what is next to what is decided here.
 */
test('every panel is a tile of one grid, inspection beside bots', () => {
  const markup = render();

  assert.doesNotMatch(markup, /class="fx-rail/, 'no rail may wrap a panel out of the grid');
  const grid = markup.slice(markup.indexOf('class="fx-grid"'));

  const order = [...grid.matchAll(/class="fx-line-wrap|data-fx="([a-z-]+)"/g)].map((m) => m[1] ?? 'line');
  assert.deepEqual(
    order,
    ['line', 'inspection', 'bots', 'goal-floor', 'yard', 'shift-log', 'signals'],
    'the grid must hold every panel, in reading order, with the two halves of the moment adjacent',
  );
});

/**
 * Ended shifts are the desks' argument one panel down: the count is worth having
 * in the head, the cards are history, and history above the bots that are out now
 * makes the panel read as longer than the fleet is. So the floor draws the count
 * and the cards open in front of it — which means the assertion is that no *spent*
 * bot is on the floor at all, since `renderToStaticMarkup` cannot open the modal.
 */
test('an ended shift is a count in the bots head, not a card on the floor', () => {
  const markup = render();
  const bots = markup.slice(markup.indexOf('data-fx="bots"'), markup.indexOf('data-fx="goal-floor"'));

  assert.match(bots, /<button[^>]*>[1-9]\d* shifts? ended</, 'the head must carry the count, as the way in');
  assert.doesNotMatch(markup, /fx-bot fx-sunk[^"]*spent/, 'and no bot whose shift ended may be drawn on the floor');
  assert.doesNotMatch(markup, /class="fx-sub">Shifts/, 'nor the subheading the list stood under');
});

/**
 * Off the air. Every panel on this floor is a reading the harness confirms, and a
 * stale one is drawn in exactly the chrome of a live one — so a "live/offline"
 * chip in the corner asks an operator to remember to check it before believing
 * anything else. The floor states it instead and draws nothing else.
 */
test('a dropped link empties the floor rather than dating it', () => {
  const live = render();
  assert.doesNotMatch(live, />live</, 'a connected cockpit must not spend bar width saying so');

  const off = render(undefined, true, false);
  assert.match(off, /Off the air/, 'a dropped link must be stated');
  assert.doesNotMatch(off, /class="fx-grid"/, 'and nothing the harness stopped confirming may be drawn');
  for (const gauge of ['Scan', 'Bots', 'Alerts', 'Faults']) {
    assert.doesNotMatch(off, new RegExp(`>${gauge}<`), `${gauge} is a number nobody is confirming`);
  }
});

/**
 * A clear deletes the rows, for every cockpit rather than this one — so it is two
 * clicks, and it is only offered when there is something to clear.
 */
test('faults offer a clear only when there are faults', () => {
  const withFaults = renderDesk(FaultLog);
  assert.match(withFaults, /clear all \d+\?|>clear</, 'recorded faults must offer a clear');

  const none = renderDesk(FaultLog, (s) => (s.errors = []));
  assert.match(none, /No faults recorded\./);
  assert.doesNotMatch(none, />clear</, 'an empty log must not offer a clear');
});

/**
 * Position comes from **structure alone** — refs and dependency edges, no status,
 * no timestamps — which is what stops a floor being re-laid on every poll and
 * jittering exactly when an operator is watching it most closely.
 */
test('the floor lays out from structure and nothing else', () => {
  const refs = ['a', 'b', 'c', 'd'];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'd' },
  ];
  const first = layoutFloor(refs, edges);
  const columns = (l: ReturnType<typeof layoutFloor>) => refs.map((r) => l.slots.get(r)?.column);
  assert.deepEqual(columns(first), [0, 1, 2, 2], 'column is dependency depth');
  assert.notEqual(first.slots.get('c')?.lane, first.slots.get('d')?.lane, 'siblings share a column, not a lane');

  // The same structure a second time, from a fresh array (so nothing is passing
  // by identity), must land in exactly the same places.
  const again = layoutFloor(
    [...refs],
    edges.map((e) => ({ ...e })),
  );
  assert.deepEqual(columns(again), columns(first));
  assert.equal(again.columns, first.columns);
  assert.equal(again.lanes, first.lanes);
});

/**
 * The converging graph the design is drawn against:
 *
 *     PR1 ─┬─> PR2 ──> PR4 ─┬─> PR5
 *          └─> PR3 ──────────┘
 *
 * PR5 must land to the right of **everything** it waits on, which is the
 * longest-path property and precisely what a naive `dependsOn[0]` depth gets
 * wrong. The layout tolerated this before the plan schema could emit it; #170
 * relaxed the arity cap and needed no cockpit change — see the end-to-end test at
 * the bottom of this file, which drives the same shape out of the real store.
 */
test('a converging part lands right of everything it waits on', () => {
  const refs = ['pr1', 'pr2', 'pr3', 'pr4', 'pr5'];
  const edges = [
    { from: 'pr1', to: 'pr2' },
    { from: 'pr1', to: 'pr3' },
    { from: 'pr2', to: 'pr4' },
    { from: 'pr3', to: 'pr5' },
    { from: 'pr4', to: 'pr5' },
  ];
  const layout = layoutFloor(refs, edges);
  const col = (r: string) => layout.slots.get(r)!.column;
  assert.equal(col('pr1'), 0);
  assert.equal(col('pr2'), 1);
  assert.equal(col('pr3'), 1);
  assert.equal(col('pr4'), 2);
  // Not 2 — which is what taking the first dependency's depth would have given.
  assert.equal(col('pr5'), 3, 'a merger draws right of its deepest prerequisite');
  assert.ok(col('pr5') > col('pr3') && col('pr5') > col('pr4'));

  // Where the lanes divide and where they rejoin, from the edge list alone.
  assert.deepEqual(floorFixtures(edges), [
    { ref: 'pr1', kind: 'splitter' },
    { ref: 'pr5', kind: 'merger' },
  ]);
});

/**
 * A cycle is rejected at the server's zod boundary, but this runs against
 * whatever the snapshot happens to carry and a cockpit that hangs is worse than
 * one that draws a cycle flat.
 */
test('the floor survives a dependency cycle', () => {
  const layout = layoutFloor(
    ['a', 'b'],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  );
  assert.equal(layout.slots.size, 2);
});

/** A replan retires parts, and a retired part is not work the plan still owes. */
test('the floor drops retired parts', () => {
  const floor = buildGoalFloor(
    floorInput({
      parts: [planPart('a', [], 'merged', 1), planPart('b', ['a'], 'retired', 2)],
    }),
  );
  const slugs = floor.machines.filter((m) => m.kind === 'assembler').map((m) => m.ref);
  assert.deepEqual(slugs, ['issue:9:part:a']);
});

/**
 * Both terminals are done. A concluded part produced a write-up or a
 * determination rather than a merge, and there is nothing left to wait for —
 * the same reading `partSettled` gives on the server.
 */
test('every plan part status folds to a progress', () => {
  const statuses = [
    'pending',
    'ready',
    'dispatched',
    'in_review',
    'merged',
    'concluded',
    'blocked',
    'retired',
  ] as const;
  for (const status of statuses) {
    const progress = partProgress(planPart('s', [], status, 1));
    assert.ok(assemblerStatus(progress, {}).word.length > 0, `${status} rendered no word`);
  }
  assert.equal(partProgress(planPart('s', [], 'merged', 1)), 'shipped');
  assert.equal(partProgress(planPart('s', [], 'concluded', 1)), 'shipped');
});

/**
 * The whole point of #158 having given intake a verdict. A goal nothing has
 * assayed draws **no drill**; one refused at intake draws a drill that is
 * stopped and carries the reason it wrote on the ticket. Collapsing the two
 * would put the feature back.
 */
test('absent is not stopped', () => {
  const untouched = buildGoalFloor(floorInput({}));
  assert.equal(
    untouched.machines.find((m) => m.kind === 'assay'),
    undefined,
    'a goal nobody has assayed has no drill at all',
  );

  const refused = buildGoalFloor(
    floorInput({
      assay: { verdict: 'unclear', summary: 'Name one behaviour that is wrong today.', by: 'assayer', decidedAt: NOW },
    }),
  );
  const drill = refused.machines.find((m) => m.kind === 'assay');
  assert.ok(drill, 'a refused goal must draw a drill');
  assert.equal(drill.status.tone, 'bad');
  assert.equal(drill.presence, 'built');
  // The reason is the harness's own, quoted rather than composed.
  assert.ok(
    refused.plates.some((p) => p.text === 'Name one behaviour that is wrong today.'),
    'a stopped machine must carry the reason the harness computed',
  );
});

/**
 * The refusal is the one intake reading that *blocks* dispatch, so it is the one
 * that gets an override — and the plate says which issue it would override, so
 * the component never has to decide that for itself. A `workable` verdict blocks
 * nothing and draws no plate at all; if one is ever added, this is what stops it
 * silently growing buttons that change a reading nothing acts on.
 */
test('only a refused assay carries an override', () => {
  const refused = buildGoalFloor(
    floorInput({
      assay: { verdict: 'unclear', summary: 'Name one behaviour that is wrong today.', by: 'assayer', decidedAt: NOW },
    }),
  );
  const plate = refused.plates.find((p) => p.assayIssue !== null);
  assert.ok(plate, 'a refused goal must offer an override somewhere on its floor');
  assert.equal(plate.assayIssue, 9, 'the override names the issue it would rewrite');
  assert.equal(plate.text, 'Name one behaviour that is wrong today.', 'the assayer is still quoted verbatim');

  const workable = buildGoalFloor(
    floorInput({ assay: { verdict: 'workable', summary: 'Clear enough.', by: 'assayer', decidedAt: NOW } }),
  );
  assert.equal(
    workable.plates.find((p) => p.assayIssue !== null),
    undefined,
    'a verdict that blocks nothing gets no override',
  );

  // Every other plate the floor can draw leaves the field null, so the component's
  // one test for "is this the assay plate" cannot be right by accident.
  const busy = buildGoalFloor(
    floorInput({
      plan: { ...PLAN, status: 'awaiting_approval', reason: 'Three parts, stacked.' },
      parts: [planPart('a', [], 'ready', 1)],
      shortfall: { cause: 'plan', partSlug: null, summary: 'Still not delivered.', by: 'assessor', decidedAt: NOW },
    }),
  );
  assert.ok(busy.plates.length > 0, 'the busy floor must draw plates for this to mean anything');
  assert.ok(
    busy.plates.every((p) => p.assayIssue === null),
    'no plate but the refusal may carry an override',
  );
});

/**
 * The floor is the second entry point onto the shared action, so what it draws is
 * asserted here rather than trusted: two buttons and not one toggle (clearing is
 * a delete, and `null` is not `workable`), and the sentence saying the hold also
 * lifts by itself — without which an operator overrides goals an edit would have
 * fixed honestly.
 */
test('a refused floor draws the override, and a workable one does not', () => {
  const renderFloor = (assay: Issue['assay']): string => {
    const input = floorInput({ assay });
    return renderToStaticMarkup(
      createElement(GoalFloor, {
        issues: [input.issue],
        plans: input.plan ? [input.plan] : [],
        parts: input.parts,
        openPrs: [],
        closedPrs: [],
        tasks: [],
        upcoming: [],
        refUrls: {},
        stopped: false,
        onViewPlan: () => undefined,
        onReplan: () => undefined,
        onSetAssay: () => undefined,
        onFetchWork: () => Promise.resolve({ nodes: [] }),
        // Gates off: these two assert the plan and assay controls, not visibility.
        watchLabel: '',
        ignoreLabel: '',
      }),
    );
  };

  const refused = renderFloor({
    verdict: 'unclear',
    summary: 'Name one behaviour that is wrong today.',
    by: 'assayer',
    decidedAt: NOW,
  });
  assert.match(refused, /Work it anyway/, 'a refused goal must be workable anyway from the floor');
  assert.match(refused, /Clear verdict/, 'clearing is a third option, not the same button');
  assert.match(refused, /Name one behaviour that is wrong today\./, 'the buttons sit beside the reason, not over it');
  assert.match(refused, /ends by itself/, 'the panel must say the hold lifts on the next edit to the ticket');

  const workable = renderFloor({ verdict: 'workable', summary: 'Clear enough.', by: 'assayer', decidedAt: NOW });
  assert.doesNotMatch(workable, /Work it anyway/, 'a verdict that blocks nothing offers no override');
  assert.doesNotMatch(workable, /Clear verdict/);
});

/**
 * The plan is readable for as long as there is one.
 *
 * These controls used to ride on the Blueprint plate, which draws only while a
 * decomposition is `awaiting_approval` — so the click that approved a plan was
 * also the one that took away the only way to read it back. Asserted across every
 * status rather than on the one that was broken: a plate is a stopped machine's
 * reason and every reason is transient, so any later attempt to hang the way in
 * off one fails here.
 */
test('the floor opens its plan whatever the plan is doing', () => {
  const renderFloor = (plan: Plan | null): string => {
    const input = floorInput({ plan, parts: plan ? [planPart('a', [], 'ready', 1)] : [] });
    return renderToStaticMarkup(
      createElement(GoalFloor, {
        issues: [input.issue],
        plans: input.plan ? [input.plan] : [],
        parts: input.parts,
        openPrs: [],
        closedPrs: [],
        tasks: [],
        upcoming: [],
        refUrls: {},
        stopped: false,
        onViewPlan: () => undefined,
        onReplan: () => undefined,
        onSetAssay: () => undefined,
        onFetchWork: () => Promise.resolve({ nodes: [] }),
        // Gates off: these two assert the plan and assay controls, not visibility.
        watchLabel: '',
        ignoreLabel: '',
      }),
    );
  };

  for (const status of ['planning', 'single', 'awaiting_approval', 'active', 'complete', 'abandoned'] as const) {
    const markup = renderFloor({ ...PLAN, status, reason: 'Three parts, stacked.' });
    assert.match(markup, /Open plan/, `a ${status} plan must be openable from the floor`);
    assert.match(markup, /Replan/, `a ${status} plan must be replannable from the floor`);
  }

  // The awaiting-approval plate still quotes the planner beside the floor; what
  // moved is only where the buttons live, so the reason must not have gone with them.
  assert.match(
    renderFloor({ ...PLAN, status: 'awaiting_approval', reason: 'Three parts, stacked.' }),
    /Three parts, stacked\./,
    'the planner still speaks on the plate the buttons left',
  );

  const none = renderFloor(null);
  assert.doesNotMatch(none, /Open plan/, 'a goal with no plan offers nothing to open');
  assert.doesNotMatch(none, /Replan/);
});

/** Every arm of the new vocabulary renders a word — a blank machine says nothing. */
test('every goal-floor stage has a word', () => {
  const pickups: string[] = [
    'done',
    'has_pr',
    'active',
    'ignored',
    'unwatched',
    'planning',
    'delivered',
    'assay',
    'cooldown',
    'escalated',
    'blocked',
    'eligible',
  ];
  for (const s of pickups) assert.ok(patchStatus(s).word.length > 0, `patch ${s} rendered no word`);
  // A cockpit may be a version behind its server, so an unknown status falls
  // back rather than rendering blank.
  assert.ok(patchStatus('something-new').word.length > 0);

  for (const s of ['planning', 'single', 'awaiting_approval', 'active', 'complete', 'abandoned'])
    assert.ok(furnaceStatus(s).word.length > 0, `furnace ${s} rendered no word`);
  assert.ok(furnaceStatus('something-new').word.length > 0);

  for (const v of ['workable', 'unclear'] as const) assert.ok(assayStatus(v).word.length > 0);
  for (const p of ['shipped', 'building', 'ready', 'locked', 'blocked'] as const)
    assert.ok(assemblerStatus(p, {}).word.length > 0, `assembler ${p} rendered no word`);
  for (const r of ['shipped', 'scrapped', 'repairing', 'held', 'blocked', 'on_the_pad'] as const)
    assert.ok(prMachineStatus(r).word.length > 0, `pr ${r} rendered no word`);
  for (const s of ['pass', 'damaged', 'not_ours', 'muted', 'awaiting'] as const)
    assert.ok(scannerStatus(s).word.length > 0, `scanner ${s} rendered no word`);
  for (const r of ['unbuilt', 'verified', 'returned'] as const)
    assert.ok(satelliteStatus(r).word.length > 0, `satellite ${r} rendered no word`);
  for (const c of ['plan', 'part', 'goal', null] as const) assert.ok(returnRoute(c).length > 0);
  assert.ok(siloStatus(0, 0).word.length > 0);
  assert.ok(siloStatus(1, 3).word.length > 0);
  assert.ok(siloStatus(3, 3).word.length > 0);
  assert.ok(manifestStatus(true).word.length > 0 && manifestStatus(false).word.length > 0);
  // Both signals the signal post claims, in every combination: a plan with no
  // comment must say so rather than fall silent, and "no plan at all" is a third
  // reading rather than a shade of the second.
  for (const state of ['Done', null] as const)
    for (const comment of ['written', 'unwritten', 'no_plan'] as const)
      assert.ok(
        signalPostStatus(state, comment).word.length > 0,
        `signal post ${state ?? 'no state'}/${comment} rendered no word`,
      );
  assert.ok(launchStatus(true).word.length > 0 && launchStatus(false).word.length > 0);

  // Every tone has a colour, including the two the floor added: a tone with no
  // value paints an SVG attribute with the string "undefined".
  for (const tone of ['ok', 'warn', 'bad', 'idle', 'off', 'ghost', 'next'] as const)
    assert.match(toneColor(tone), /^var\(--/);
});

/**
 * A CI machine's state comes from the classification verdict, never from a
 * check's name — so a floor running against a config naming any check at all
 * renders with no code change here.
 *
 * Human review is the exception worth knowing: reviewer policies deliberately do
 * not fold into `ciChecks` (they map to `approved`/`unresolvedComments`), so that
 * one scanner is fed from `pr.approved` or it is permanently absent.
 */
test('scanners are generated from the verdict, and human review from approval', () => {
  const floor = buildGoalFloor(
    floorInput({
      linkedPrNumber: 77,
      openPrs: [
        {
          id: 'pr-77',
          number: 77,
          title: 'Do the thing',
          branch: 'issue/9',
          ciStatus: 'failing',
          unresolvedComments: [],
          approved: false,
          ciVerdict: {
            actionable: true,
            dispatch: [{ name: 'alpha', rule: null }],
            escalate: [{ name: 'beta', rule: null }],
            ignored: [{ name: 'gamma', rule: null }],
            urgent: false,
          },
        } as PullRequest,
      ],
    }),
  );
  const pr = floor.machines.find((m) => m.kind === 'pr');
  assert.ok(pr);
  assert.deepEqual(
    pr.scanners.map((s) => [s.name, s.state]),
    [
      ['alpha', 'damaged'],
      ['beta', 'not_ours'],
      ['gamma', 'muted'],
      ['human review', 'awaiting'],
    ],
  );
  assert.equal(pr.status.word, 'Repair en route');

  // Nothing dispatchable and something held: the harness is waiting on the
  // outside world, which is amber rather than red.
  const held = buildGoalFloor(
    floorInput({
      linkedPrNumber: 77,
      openPrs: [
        {
          id: 'pr-77',
          number: 77,
          title: 'Do the thing',
          branch: 'issue/9',
          ciStatus: 'failing',
          unresolvedComments: [],
          approved: true,
          ciVerdict: {
            actionable: false,
            dispatch: [],
            escalate: [{ name: 'beta', rule: null }],
            ignored: [],
            urgent: false,
          },
        } as PullRequest,
      ],
    }),
  );
  const heldPr = held.machines.find((m) => m.kind === 'pr')!;
  assert.equal(heldPr.status.word, 'Held — not ours');
  assert.equal(heldPr.scanners.at(-1)?.state, 'pass', 'an approved PR reads as a passed human review');
});

/** An unapproved decomposition is drawn, and nothing on it is built. */
test('an awaiting-approval plan draws ghosts', () => {
  const floor = buildGoalFloor(
    floorInput({
      plan: { ...PLAN, status: 'awaiting_approval', reason: 'Signer first, then the route.' },
      parts: [planPart('signer', [], 'ready', 1), planPart('route', ['signer'], 'ready', 2)],
    }),
  );
  const assemblers = floor.machines.filter((m) => m.kind === 'assembler');
  assert.equal(assemblers.length, 2);
  assert.ok(assemblers.every((m) => m.presence === 'ghost' && m.status.word === 'Not connected'));
  assert.ok(floor.plates.some((p) => p.text === 'Signer first, then the route.'));
});

/**
 * A goal nothing has staked a claim to gets no floor — and the three things that
 * are not simply "filter on the tag" are each asserted, because each of them is a
 * way the panel could go confidently blank.
 */
test('the floor draws the goals we have a claim staked to', () => {
  const goal = (number: number, labels: string[], pickup = 'eligible'): Issue => ({
    id: `iss-${number}`,
    number,
    title: `Goal ${number}`,
    body: '',
    labels,
    state: 'open',
    linkedPrNumber: null,
    pickup: { eligible: pickup === 'eligible', status: pickup, reasons: [] },
    assay: null,
    shortfall: null,
  });
  const GATE = { watchLabel: 'lubbdubb-watch', ignoreLabel: 'lubbdubb-ignore' };
  const numbers = (issues: Issue[]): number[] => floorGoals(issues, GATE).map((i) => i.number);

  assert.deepEqual(numbers([goal(1, []), goal(2, ['lubbdubb-watch'])]), [2], 'an untagged goal has no production line');
  assert.deepEqual(numbers([goal(3, ['lubbdubb-ignore'])]), [], 'leave-alone means leave off the floor too');

  // Work in flight is drawn whatever the tags say: a tag pulled mid-flight must
  // not make a live plan, an open PR or a running agent invisible.
  assert.deepEqual(numbers([goal(4, [], 'planning'), goal(5, [], 'has_pr'), goal(6, [], 'eligible')]), [4, 5]);
  assert.deepEqual(numbers([goal(7, ['lubbdubb-ignore'], 'active')]), [7], 'an ignored goal with an agent is seen');

  // Claimed first, then by number — the strip is a place positions are learned,
  // so it is ordered on the two things that barely move.
  assert.deepEqual(
    numbers([
      goal(11, [], 'active'),
      goal(9, ['lubbdubb-watch']),
      goal(12, [], 'planning'),
      goal(8, ['lubbdubb-watch']),
    ]),
    [8, 9, 11, 12],
  );

  // The act-on-everything escape hatch: issues default opt-out, so an empty watch
  // label filtering anything would hide every goal on exactly the deployments that
  // turned the gate off.
  assert.deepEqual(
    floorGoals([goal(2, []), goal(1, [])], { watchLabel: '', ignoreLabel: '' }).map((i) => i.number),
    [1, 2],
  );
});

/** And the panel reads that list, rather than the world's — including its empty state. */
test('the goal floor strip is the staked goals', () => {
  const base = floorInput({}).issue;
  const open = (number: number, labels: string[]): Issue => ({
    ...base,
    id: `iss-${number}`,
    number,
    title: `Goal ${number}`,
    labels,
    pickup: { eligible: labels.length > 0, status: labels.length > 0 ? 'eligible' : 'unwatched', reasons: [] },
  });
  const render = (issues: Issue[]): string =>
    renderToStaticMarkup(
      createElement(GoalFloor, {
        issues,
        plans: [],
        parts: [],
        openPrs: [],
        closedPrs: [],
        tasks: [],
        upcoming: [],
        refUrls: {},
        stopped: false,
        watchLabel: 'lubbdubb-watch',
        ignoreLabel: 'lubbdubb-ignore',
        onViewPlan: () => undefined,
        onReplan: () => undefined,
        onSetAssay: () => undefined,
        onFetchWork: () => Promise.resolve({ nodes: [] }),
      }),
    );

  // The strip itself, not only the floor it opens on: mapping the world's own list
  // here draws every ticket back with a floor one click away, which is the whole
  // filter defeated by the one line that still reads `issues`.
  const mixed = render([open(1, []), open(2, ['lubbdubb-watch'])]);
  assert.deepEqual(mixed.match(/issue:\d+ · ore patch/g), ['issue:2 · ore patch'], 'the strip is the staked goals');

  const unwatched = render([open(1, [])]);
  assert.match(unwatched, /No goals have a claim staked/, 'nothing staked is a different fact from an empty world');
  assert.doesNotMatch(unwatched, /ore patch/, 'and it draws no strip at all');
});

/**
 * The tail is on the goal check's **yes** arm, which is why no floor in flight
 * reaches it: a shortfall returns before this point.
 */
test('the loop reaches an end, and the end is drawn', () => {
  const inFlight = buildGoalFloor(floorInput({ parts: [planPart('a', [], 'in_review', 1)] }));
  assert.equal(
    inFlight.machines.some((m) => m.kind === 'manifest'),
    false,
  );
  assert.equal(
    inFlight.machines.some((m) => m.kind === 'launch'),
    false,
  );
  assert.equal(inFlight.machines.find((m) => m.kind === 'satellite')?.presence, 'unbuilt');

  const delivered = buildGoalFloor(
    floorInput({
      pickup: 'delivered',
      workItemState: 'Done',
      // The verdict is the *delivery* row, not a conclusion: `resolveIssueConclusion`
      // cannot return `{by: 'assessor', verdict: 'done'}` — that arm went to
      // `issue_deliveries` in the two-record split — so a fixture asserting one was
      // asserting against a shape the server never sends. The conclusion beside it
      // is what the server really resolves for a merged plan, and it is here to
      // prove the satellite is not reading it.
      delivery: { summary: 'retry wraps both call sites', by: 'assessor', decidedAt: NOW },
      conclusion: { verdict: 'done', by: 'plan', note: 'every part of the plan merged', at: null },
      parts: [planPart('a', [], 'merged', 1)],
    }),
  );
  assert.deepEqual(
    delivered.machines.map((m) => m.kind),
    ['patch', 'furnace', 'assembler', 'silo', 'satellite', 'manifest', 'signal', 'launch'],
  );
  assert.equal(delivered.machines.find((m) => m.kind === 'satellite')?.status.word, 'Verified');
  assert.equal(delivered.machines.find((m) => m.kind === 'launch')?.status.word, 'Away');

  // The signal post claims both signals the harness sends (#171), and the three
  // readings of the status comment stay three: a plan that has written one, a
  // plan that has not, and no plan at all — which is not a plan gone quiet but
  // nothing that could ever have written. The reading is the meta *line*; the way
  // in is the machine's `link`, and the two stay apart so a provider that builds
  // no URLs can still say a notice went out. Neither ever prints the ref.
  const signalOf = (over: Parameters<typeof floorInput>[0]) =>
    buildGoalFloor(
      floorInput({
        pickup: 'delivered',
        workItemState: 'Done',
        conclusion: { verdict: 'done', by: 'assessor', note: 'retry wraps both call sites', at: NOW },
        parts: [planPart('a', [], 'merged', 1)],
        ...over,
      }),
    ).machines.find((m) => m.kind === 'signal');

  const unwritten = signalOf({});
  const written = signalOf({ plan: { ...PLAN, statusCommentRef: 'issue:212:comment:9' } });
  const noPlan = signalOf({ plan: null, parts: [] });
  assert.notEqual(written?.status.word, unwritten?.status.word, 'a written status comment must read differently');
  assert.deepEqual(written?.meta, ['state · Done', 'status comment · written']);
  assert.deepEqual(unwritten?.meta, ['state · Done', 'status comment · none written']);
  assert.deepEqual(noPlan?.meta, ['state · Done', 'no plan · no status comment to write']);
  assert.ok(
    [written, unwritten, noPlan].every(
      (m) => !m?.meta.some((line) => line.includes('comment:9') || line.includes('http')),
    ),
    'the ref is machinery: it is looked up, never printed',
  );
  // The link is carried, captioned, and only where there is something to open —
  // and never beside a pull request, which owns the same corner of the node.
  assert.deepEqual(written?.link, { ref: 'issue:212:comment:9', label: 'notice ↗' });
  assert.equal(unwritten?.link, null);
  assert.equal(noPlan?.link, null);
  assert.equal(
    delivered.machines.filter((m) => m.link !== null && m.prNumber !== null).length,
    0,
    'a machine never claims two ways out',
  );

  // A shortfall returns before the tail, and names the route it goes back on.
  const short = buildGoalFloor(
    floorInput({
      pickup: 'eligible',
      shortfall: {
        cause: 'plan',
        partSlug: null,
        summary: 'The retry-after header is never set.',
        by: 'assessor',
        decidedAt: NOW,
      },
      parts: [planPart('a', [], 'merged', 1)],
    }),
  );
  assert.equal(
    short.machines.some((m) => m.kind === 'manifest'),
    false,
    'a shortfall returns before the tail',
  );
  assert.equal(short.machines.find((m) => m.kind === 'launch')?.status.word, 'Returned');
  const plate = short.plates.find((p) => p.route);
  assert.equal(plate?.route, 'plan');
  assert.equal(plate?.text, 'The retry-after header is never set.');
});

/**
 * The reported bug, which is a *decomposed* delivered issue and only that.
 *
 * The tail used to be read off `pickup.status`, and `issuePickupStatus` answers
 * its plan `parts` arm before the delivery park — so the one shape that reaches
 * the end of the workflow, a plan whose parts all merged and whose goal the
 * assessor then verified, reported `planning` and drew no goal check, no
 * manifest, no signal post and no launch. Every input here is what the server
 * really sends for that issue: the plan arm's status and its reason, the
 * plan-derived conclusion, and the delivery beside them.
 */
test('a delivered goal draws its check and its tail even while the plan arm owns the pickup status', () => {
  const floor = buildGoalFloor(
    floorInput({
      plan: { ...PLAN, status: 'complete' },
      parts: [planPart('a', [], 'merged', 1), planPart('b', [], 'merged', 2)],
      pickup: 'planning',
      pickupReasons: ['plan complete — all 2 parts finished; close the issue or replan'],
      conclusion: { verdict: 'done', by: 'plan', note: 'every part of the plan merged', at: null },
      delivery: { summary: 'both call sites retry', by: 'assessor', decidedAt: NOW },
    }),
  );

  const satellite = floor.machines.find((m) => m.kind === 'satellite');
  assert.equal(satellite?.status.word, 'Verified', 'the goal check ran and passed; the floor must say so');
  assert.equal(satellite?.presence, 'built');
  // Credited to the assessor, never to the plan roll-up beside it.
  assert.ok(satellite?.meta.includes('by assessor'), `satellite credited ${satellite?.meta.join(', ')}`);

  assert.deepEqual(
    floor.machines.map((m) => m.kind),
    ['patch', 'furnace', 'assembler', 'assembler', 'silo', 'satellite', 'manifest', 'signal', 'launch'],
    'the whole yes arm draws, not just the satellite',
  );
  assert.equal(floor.machines.find((m) => m.kind === 'launch')?.status.word, 'Away');

  // The patch keeps the plan's word and the plan's plate: "delivered" and "plan
  // complete" are two true readings of two different questions, and the operator
  // still has to close the issue or replan.
  assert.equal(floor.machines.find((m) => m.kind === 'patch')?.status.word, 'Being mined');
  assert.ok(
    floor.plates.some((p) => p.text === 'plan complete — all 2 parts finished; close the issue or replan'),
    'the way out of a complete plan is still quoted',
  );
});

/**
 * A verdict the world has overtaken is not shipped at all, so absence has to
 * read as "no standing goal check" rather than "there was never one" — and the
 * floor must fall back to unbuilt rather than remembering.
 */
test('a goal floor with no standing delivery draws no goal check', () => {
  const released = buildGoalFloor(
    floorInput({
      plan: { ...PLAN, status: 'complete' },
      parts: [planPart('a', [], 'merged', 1)],
      pickup: 'eligible',
      // The plan roll-up still says done. It is not a goal check and must not be
      // read as one, or the fix trades its bug for the inverse.
      conclusion: { verdict: 'done', by: 'plan', note: 'every part of the plan merged', at: null },
      delivery: null,
    }),
  );
  assert.equal(released.machines.find((m) => m.kind === 'satellite')?.status.word, 'Not yet built');
  assert.equal(released.machines.find((m) => m.kind === 'satellite')?.presence, 'unbuilt');
  assert.equal(
    released.machines.some((m) => m.kind === 'launch'),
    false,
    'a released issue is back in play, so nothing has launched',
  );
});

/**
 * The belt is the harness running. A belt still moving under a stopped harness
 * is the one confidently-wrong thing this layout could draw, so it is asserted
 * rather than trusted to the CSS.
 */
test('the goal floor belts stop with the harness', () => {
  assert.match(render(), /fx-gf-belt lit /, 'a running harness must leave a lit belt running');
  assert.doesNotMatch(render(), /fx-gf-belt[^"]*stopped/, 'nothing stops a belt while cycles run');
  assert.match(
    render((s) => (s.control.paused = true)),
    /fx-gf-belt[^"]*stopped/,
    'paused must stop every belt on the floor',
  );
});

/**
 * The ladder is two groups, and the split is an argument about denominators.
 *
 * `siloGates`' fixed four existed because `health.reasons` names only what is
 * wrong — a numerator with no bottom. That holds for the three gates a *human*
 * moves and fails for CI, because `ciVerdict` is an enumerable list of named
 * checks with states. So CI left the fixed set and became the scanner group.
 */
test('the ladder is the configured checks, then a fixed three a human moves', () => {
  const pr = (over: Partial<PullRequest>): PullRequest =>
    ({
      id: 'pr-1',
      number: 1,
      title: 'x',
      branch: 'b',
      ciStatus: 'passing',
      unresolvedComments: [],
      approved: true,
      mergeable: true,
      mergeableState: 'clean',
      ...over,
    }) as PullRequest;

  // The three never vary with what is wrong — every row's gate cells sit at the
  // same x, which is what lets the strip be read downward.
  assert.equal(mergeGates(pr({})).length, 3, 'the fixed group must not vary with what is wrong');
  assert.equal(mergeGates(pr({ ciStatus: 'failing' })).length, 3, 'CI is not one of them any more');
  assert.deepEqual(
    mergeGates(pr({})).map((g) => g.met),
    [true, true, true],
  );
  assert.deepEqual(
    mergeGates(pr({ approved: false })).map((g) => g.met),
    [false, true, true],
  );
  // Behind the base is a conflict for merging purposes even when `mergeable` is
  // still true — it is the state rule 2 exists to clear.
  assert.deepEqual(
    mergeGates(pr({ mergeableState: 'behind' })).map((g) => g.met),
    [true, true, false],
  );
  const commented = mergeGates(pr({ unresolvedComments: [{ id: 'c', author: 'r', body: 'b', handled: false }] }));
  assert.equal(commented[1]!.met, false);
  assert.match(commented[1]!.label, /1 unresolved comment/, 'an unmet gate is named for the state it is in');

  // The scanner group is one cell per check the policy classified, in the states
  // the verdict assigned — and *not* human review, which has its own gate here.
  const classified = ladderFor(
    pr({
      ciStatus: 'failing',
      ciVerdict: {
        actionable: false,
        dispatch: [],
        escalate: [{ name: 'codeql', rule: null }],
        ignored: [{ name: 'pages', rule: null }],
        urgent: false,
      },
    }),
  );
  assert.deepEqual(
    classified.scanners.map((s) => [s.name, s.state]),
    [
      ['codeql', 'not_ours'],
      ['pages', 'muted'],
    ],
    'every name comes off the verdict, and review is not a scanner on this row',
  );
  assert.equal(classified.gates.length, 3);

  // A provider with no per-check detail keeps the pre-policy reading: one cell.
  assert.deepEqual(
    ladderFor(pr({ ciStatus: 'failing' })).scanners.map((s) => s.state),
    ['damaged'],
  );
  assert.deepEqual(
    ladderFor(pr({ ciStatus: 'pending' })).scanners.map((s) => s.state),
    ['awaiting'],
  );
});

/**
 * The panel's whole job is answering *what needs me*, so the order is the court
 * and never the ladder. The old sort was fullest-first, which put the PRs a human
 * had to decide on below the ones the harness was already fixing.
 */
test('the rack groups on the court, and a merge-ready PR needs no arm of its own', () => {
  const at = (number: number, status: string, over: Partial<PullRequest> = {}): PullRequest =>
    ({
      id: `pr-${number}`,
      number,
      title: 't',
      branch: `b${number}`,
      ciStatus: 'passing',
      unresolvedComments: [],
      attention: { status, reasons: [`because ${status}`] },
      ...over,
    }) as PullRequest;

  assert.equal(rackGroup(at(1, 'you')), 'yours');
  assert.equal(rackGroup(at(2, 'stalled')), 'yours');
  for (const status of ['harness', 'elsewhere', 'settled', 'ignored', 'done']) {
    assert.equal(rackGroup(at(3, status)), 'in_hand', `${status} is not yours to act on`);
  }
  // No `attention` at all — an older snapshot. A blocked PR is still surfaced
  // rather than filed under "in hand" by absence.
  const noVerdict = { id: 'pr-9', number: 9, title: 't', branch: 'b9', ciStatus: 'passing', unresolvedComments: [] };
  assert.equal(rackGroup({ ...noVerdict, health: { blocked: true, reasons: ['x'] } } as PullRequest), 'yours');
  assert.equal(rackGroup({ ...noVerdict, health: { blocked: false, reasons: [] } } as PullRequest), 'in_hand');

  // A merge-ready PR reaches your court through the server's *pending proposal*
  // arm, so nothing client-side has to know what "ready" is. Under `autoSend` the
  // same PR reads `harness` and correctly drops into "in hand".
  const ready = at(4, 'you', { approved: true, mergeable: true, mergeableState: 'clean' });
  assert.equal(rackGroup(ready), 'yours');
  assert.equal(rackGroup({ ...ready, attention: { status: 'harness', reasons: ['merge-ready'] } }), 'in_hand');

  const grouped = rack([at(8, 'harness'), at(3, 'you'), at(5, 'harness'), at(1, 'stalled')]);
  assert.deepEqual(
    grouped.yours.map((p) => p.number),
    [1, 3],
    'your court first, and by number inside it — never by how full the ladder is',
  );
  assert.deepEqual(
    grouped.inHand.map((p) => p.number),
    [5, 8],
  );

  // The chip is the server's word, never re-derived.
  assert.equal(prCourt(at(1, 'you')).tone, 'bad');
  assert.equal(prCourt(at(1, 'settled')).label, 'Settled — you said no');
  assert.equal(loadedCount([{ merged: true } as PullRequest, { state: 'closed' } as PullRequest]), 1);
});

/**
 * The rocket is the launch's and nothing else's. It was double-booked against
 * `iconForStage`'s launch, which left the one event that *is* a launch — the goal
 * closing — falling through to a flask.
 */
test('the rocket belongs to the goal closing, not to a merge', () => {
  assert.equal(iconForEventKind('issue_closed'), 'rocket');
  assert.equal(iconForEventKind('pr_merged'), 'pr');
  assert.equal(iconForStage('launch'), 'rocket');
  const marks = (['pr_ci', 'pr_opened', 'pr_comment', 'pr_approved', 'pr_closed'] as const).map(iconForEventKind);
  assert.ok(!marks.includes('rocket'), 'nothing about a pull request wears the launch mark');
});

/**
 * Empty still draws. A surface that vanishes when quiet is indistinguishable from
 * one that broke — the rule the fault gauge is kept muted-but-present for.
 */
test('the rack says the rack is empty rather than drawing nothing', () => {
  const html = renderToStaticMarkup(createElement(Inspection, { prs: [], closed: [], refUrls: {} }));
  assert.match(html, /Nothing on the rack/);
  // And a key is drawn only when there is something for it to explain.
  assert.ok(!html.includes('policy holds it'), 'no legend for an empty rack');
});

test('a drawn rack carries the group split, the states and the check names', () => {
  const mk = (n: number, over: Partial<PullRequest>): PullRequest =>
    ({
      id: `p${n}`,
      number: n,
      title: `PR ${n}`,
      branch: `b${n}`,
      ciStatus: 'passing',
      unresolvedComments: [],
      ...over,
    }) as PullRequest;
  const html = renderToStaticMarkup(
    createElement(Inspection, {
      prs: [
        mk(139, {
          ciStatus: 'failing',
          attention: { status: 'you', reasons: ['codeql failing — the CI policy holds it'] },
          ciVerdict: {
            actionable: false,
            dispatch: [],
            escalate: [{ name: 'codeql', rule: null }],
            ignored: [{ name: 'pages', rule: null }],
            urgent: false,
          },
        }),
        mk(151, {
          ciStatus: 'failing',
          attention: { status: 'harness', reasons: ['an agent is working this branch'] },
          ciVerdict: {
            actionable: true,
            dispatch: [{ name: 'check', rule: null }],
            escalate: [],
            ignored: [],
            urgent: false,
          },
        }),
      ],
      closed: [mk(140, { merged: true }), mk(141, { state: 'closed' })],
      refUrls: {},
    }),
  );

  assert.match(html, /Your court · 1/);
  assert.match(html, /In hand · 1/);
  // The row in your court carries the stripe; the one in hand is recessed instead.
  assert.match(html, /class="fx-part you"/);
  assert.match(html, /class="fx-part hand"/);
  // Each cell names its own check and the word its state carries — the shape is
  // scannable, the detail is one hover away, and the names come off the verdict.
  assert.match(html, /title="codeql — not ours"/);
  assert.match(html, /title="pages — muted"/);
  assert.match(html, /title="check — damaged"/);
  // The three fixed gates follow every scanner group, at the same three positions.
  assert.match(html, /title="Approved — not met"/);
  assert.match(html, /title="No conflicts with base — met"/);
  // The court is the server's word, and the reason is quoted.
  assert.match(html, /the CI policy holds it/);
  assert.match(html, /Harness working it/);
  // One merge in the window, and the abandoned PR is not counted as loaded.
  assert.match(html, /1 part loaded into the silo/);
});

/**
 * Rates, not counts: the panel exists to answer whether the floor is producing,
 * and the churn ratio is the number that separates producing from spinning.
 */
test('production counts only what landed, and says when it cannot see far enough', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();
  const decision = (type: string, outcome: string, mins: number): Decision => ({
    id: `d-${type}-${mins}`,
    cycleId: 'c',
    action: { type },
    outcome,
    detail: '',
    rule: null,
    createdAt: ago(mins),
  });

  const reading = productionReading({
    decisions: [
      decision('dispatch_fix_ci', 'ok', 30),
      decision('dispatch_issue', 'executed', 90),
      // Held and skipped dispatches produced no work and must not count as output.
      decision('dispatch_issue', 'held', 100),
      decision('dispatch_issue', 'skipped', 110),
      decision('escalate', 'ok', 45),
    ],
    worldEvents: [{ id: 'w', kind: 'pr_merged', ref: 'pr:1', summary: 'merged', createdAt: ago(20) } as WorldEvent],
    fiveHourCostUsd: 5,
    now,
  });

  const by = (key: string) => reading.series.find((s) => s.key === key);
  assert.equal(
    by('dispatches')?.points.reduce((a, b) => a + b, 0),
    2,
    'a held dispatch is not a dispatch',
  );
  assert.equal(
    by('merges')?.points.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(
    by('escalations')?.points.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(reading.churnRatio, 2);
  assert.equal(reading.costPerHour, 1);

  // The log's own reach, not a guess at the server's row limit: nothing older
  // than the window means the window is not covered, and every rate off it is a
  // floor rather than a total.
  assert.equal(reading.truncated, true);
  assert.equal(
    productionReading({
      decisions: [decision('dispatch_issue', 'ok', 7 * 60)],
      worldEvents: [],
      fiveHourCostUsd: null,
      now,
    }).truncated,
    false,
  );
});

/** Nothing merged is a real reading, and it is not a division by zero. */
test('production reports no ratio rather than an infinite one', () => {
  const reading = productionReading({
    decisions: [],
    worldEvents: [],
    fiveHourCostUsd: null,
    now: Date.parse('2026-01-01T12:00:00.000Z'),
  });
  assert.equal(reading.churnRatio, null);
  assert.equal(reading.costPerHour, null);
  assert.ok(reading.peak >= 1, 'an empty graph still needs a y-scale to divide by');
});

/**
 * These are counts, so a quarter of an event does not exist. Four fixed
 * gridlines over a raw peak labelled a quiet floor "1 1 1 0 0" — every tick has
 * to be a whole number of events or the axis is noise.
 */
test('the production axis labels whole events', () => {
  const labels = (peak: number) => {
    const { max, lines } = axisScale(peak);
    return lines.map((f) => max * (1 - f));
  };
  for (const peak of [0, 1, 2, 3, 4, 5, 7, 9, 40]) {
    for (const value of labels(peak)) {
      assert.ok(Number.isInteger(value), `peak ${peak} produced a fractional tick ${value}`);
    }
    assert.equal(new Set(labels(peak)).size, labels(peak).length, `peak ${peak} repeated a tick`);
    assert.ok(axisScale(peak).max >= peak, `peak ${peak} would be drawn off the top of its own axis`);
  }
  // An empty graph still needs a top to divide by.
  assert.equal(axisScale(0).max, 1);
});

/**
 * A segmented gauge, not a staircase of individually-charged cells: there is one
 * number here, and a per-cell level would be inventing state.
 */
test('the accumulator bank fills left to right from one number', () => {
  assert.deepEqual(accumulatorCells(100, 4), [1, 1, 1, 1]);
  assert.deepEqual(accumulatorCells(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(accumulatorCells(50, 4), [1, 1, 0, 0]);
  assert.deepEqual(accumulatorCells(25, 2), [0.5, 0]);
  // Out-of-range input clamps rather than drawing a cell fuller than full.
  assert.deepEqual(accumulatorCells(140, 2), [1, 1]);
  assert.deepEqual(accumulatorCells(-10, 2), [0, 0]);
});

/**
 * End to end for #170, and the property it was worth checking: a plan that
 * **rejoins** draws with no cockpit change at all.
 *
 * The document goes through the server's own zod boundary and the real store, and
 * the rows that come back out are what `/api/state` ships — so this is the whole
 * path from what a planner may now say to what the floor draws, rather than a
 * hand-built graph. `layoutFloor` was written to tolerate in-degree greater than
 * one before the schema could emit it; this is the first test that emits it.
 */
test('a rejoining plan, ingested by the server, draws its merger on the floor', async () => {
  const { Store } = await import('../src/store/store.js');
  const { parsePlanDocument, planPartInputs } = await import('../src/plans/planDocument.js');

  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'schema and api are independent; the wiring needs both',
      parts: [
        { slug: 'schema', title: 'The tables', scope: 'src/store/', dependsOn: [] },
        { slug: 'api', title: 'The route', scope: 'src/server/', dependsOn: [] },
        { slug: 'wire', title: 'Wire them together', scope: 'src/system.ts', dependsOn: ['schema', 'api'] },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(`the boundary must accept a rejoin: ${parsed.error}`);

  const store = new Store(':memory:');
  const plan = store.upsertPlan({ originRef: 'issue:9', title: 'A goal', status: 'active', reason: 'two lanes' });
  store.upsertPlanParts(plan.id, planPartInputs(parsed.document));
  // The wire: `/api/state` ships store rows as JSON, and the cockpit's PlanPart is
  // deliberately a separate declaration from the server's.
  const rows = JSON.parse(JSON.stringify(store.listPlanParts(plan.id))) as PlanPart[];
  store.close();

  const floor = buildGoalFloor(floorInput({ plan: PLAN, parts: rows }));
  const col = (slug: string) => floor.layout.slots.get(`issue:9:part:${slug}`)!.column;

  // Both lanes come off the furnace and land in the same column; the merger draws
  // right of both, which is the longest-path property doing its job on real rows.
  assert.equal(col('schema'), col('api'));
  assert.ok(col('wire') > col('schema') && col('wire') > col('api'));

  // The join is read off the edge list, so the fixture appears with nothing added.
  assert.deepEqual(
    floor.fixtures.filter((f) => f.kind === 'merger').map((f) => f.ref),
    ['issue:9:part:wire'],
  );
  assert.deepEqual(
    floor.edges.filter((e) => e.to === 'issue:9:part:wire').map((e) => e.from),
    ['issue:9:part:schema', 'issue:9:part:api'],
  );

  // And the machine says what it is waiting for — both of them, not the first.
  const wire = floor.machines.find((m) => m.ref === 'issue:9:part:wire')!;
  assert.ok(
    wire.meta.includes('waits on: schema + api'),
    `the merger must name every prerequisite, got ${JSON.stringify(wire.meta)}`,
  );
});
