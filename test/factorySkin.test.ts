import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { Decision, PlanPart, PullRequest, QueueItem, WorldEvent } from '../web/src/types.js';

// Same reason as `cockpitSkins.test.ts`: Vite compiles the cockpit's JSX with the
// automatic runtime and `tsx` with the classic one, so the global goes in before
// the skin modules are pulled in.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { resolveSkin } = await import('../web/src/skins/registry.js');
const { bayMachineStatus, botState, clip, crateMachineStatus, iconForOrigin, inserterPhase, signalPolarity } =
  await import('../web/src/skins/factory/vocabulary.js');
const { layoutTechTree, researchQueue } = await import('../web/src/skins/factory/techTree.js');
const { siloFill, siloGates } = await import('../web/src/skins/factory/silo.js');
const { axisScale, productionReading } = await import('../web/src/skins/factory/production.js');
const { accumulatorCells } = await import('../web/src/skins/factory/power.js');

const INERT = new Proxy({} as CockpitActions, { get: () => () => Promise.resolve() });

function render(mutate?: (s: ReturnType<typeof buildDemoState>['state']) => void): string {
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
      demo: true,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: now,
    });
    return renderToStaticMarkup(createElement(resolveSkin('factory').Root, { view, actions: INERT }));
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
    const m = /class="fx-line fx-sunk" style="width:(\d+)px"/.exec(markup);
    assert.ok(m, 'the floor rendered no width');
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
 * `dependsOn` is a prerequisite edge, so depth is how many merges must land
 * before a part can start — the one thing a flat stack cannot show, and the
 * reason this is a tree.
 */
test('the tech tree lays parts out by dependency depth', () => {
  const part = (slug: string, dependsOn: string[], status: string, seq: number): PlanPart => ({
    id: `p-${slug}`,
    planId: 'plan-1',
    slug,
    seq,
    title: slug,
    scope: 'src/',
    dependsOn,
    branch: null,
    prNumber: null,
    status,
    taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  // A chain that fans out: two parts naming one prerequisite is how a tree
  // branches when `dependsOn` holds at most one slug.
  const layout = layoutTechTree([
    part('schema', [], 'merged', 1),
    part('api', ['schema'], 'in_review', 2),
    part('cockpit', ['api'], 'ready', 3),
    part('docs', ['api'], 'pending', 4),
  ]);

  const col = (slug: string) => layout.nodes.find((n) => n.part.slug === slug)?.col;
  assert.equal(col('schema'), 0);
  assert.equal(col('api'), 1);
  assert.equal(col('cockpit'), 2);
  assert.equal(col('docs'), 2, 'siblings on one prerequisite share a column');
  assert.notEqual(
    layout.nodes.find((n) => n.part.slug === 'cockpit')?.row,
    layout.nodes.find((n) => n.part.slug === 'docs')?.row,
    'siblings must not be drawn on top of each other',
  );

  // Only an edge out of a merged part is a path work can travel.
  assert.equal(layout.edges.find((e) => e.fromSlug === 'schema')?.lit, true);
  assert.equal(layout.edges.find((e) => e.fromSlug === 'api')?.lit, false);

  // Locked parts are absent from the queue: a part whose prerequisite has not
  // merged is not queued for anything, and listing it would put four items in a
  // queue that can only start one.
  const queue = researchQueue(layout).map((n) => n.part.slug);
  assert.deepEqual(queue, ['api', 'cockpit']);
});

/** A replan retires parts, and a retired part is not work the plan still owes. */
test('the tech tree drops retired parts', () => {
  const base = {
    planId: 'plan-1',
    scope: 'src/',
    branch: null,
    prNumber: null,
    taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const layout = layoutTechTree([
    { ...base, id: 'a', slug: 'a', seq: 1, title: 'a', dependsOn: [], status: 'merged' },
    { ...base, id: 'b', slug: 'b', seq: 2, title: 'b', dependsOn: ['a'], status: 'retired' },
  ] as PlanPart[]);
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.edges.length, 0, 'an edge into a retired part is not a path');
});

/**
 * A cycle is rejected at the server's zod boundary, but this runs against
 * whatever the snapshot happens to carry and a cockpit that hangs is worse than
 * one that draws a cycle flat.
 */
test('the tech tree survives a dependency cycle', () => {
  const base = {
    planId: 'plan-1',
    scope: 'src/',
    branch: null,
    prNumber: null,
    taskId: null,
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const layout = layoutTechTree([
    { ...base, id: 'a', slug: 'a', seq: 1, title: 'a', dependsOn: ['b'] },
    { ...base, id: 'b', slug: 'b', seq: 2, title: 'b', dependsOn: ['a'] },
  ] as PlanPart[]);
  assert.equal(layout.nodes.length, 2);
});

/**
 * The fill needs a denominator, and `health.reasons` cannot be one: it names
 * only what is wrong, so it is a numerator with no bottom. These four gates are
 * what every provider maps onto.
 */
test('a silo fills on a fixed four gates', () => {
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

  assert.equal(siloGates(pr({})).length, 4, 'the denominator must not vary with what is wrong');
  assert.equal(siloFill(siloGates(pr({}))), 1);
  assert.equal(siloFill(siloGates(pr({ ciStatus: 'failing' }))), 0.75);
  assert.equal(siloFill(siloGates(pr({ ciStatus: 'failing', approved: false }))), 0.5);
  // Behind the base is a conflict for merging purposes even when `mergeable` is
  // still true — it is the state rule 2 exists to clear.
  assert.equal(siloFill(siloGates(pr({ mergeableState: 'behind' }))), 0.75);
  assert.equal(
    siloFill(siloGates(pr({ unresolvedComments: [{ id: 'c', author: 'r', body: 'b', handled: false }] }))),
    0.75,
  );
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
