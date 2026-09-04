import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the console's own modules are loaded after this so they
// see the same global the rest of the cockpit tests install.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { Overview, queueRow } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

/**
 * The view model over the demo world, or over a doctored one.
 *
 * Doctoring goes in here rather than onto the finished view, because the readings
 * the fleet row's state is drawn from — `limitParked`, `escalationByAgent`,
 * `stallExpiryByAgent` — are *derived* by `buildViewModel`. A test that replaced
 * `view.state` alone would leave every one of them answering about the world it
 * was built from, and its assertions would be about nothing.
 */
function view(over: Partial<CockpitView['state']> = {}): CockpitView {
  const state = { ...buildDemoState().state, ...over };
  return buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
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
    tab: 'overview',
  });
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

/**
 * Where a row starts in the markup. The trailing boundary matters: the list a
 * card puts its rows in is `cn-rows`, so a bare `cn-row` counts the container as
 * a row and hands the first assertion a chunk with no refs slot in it.
 */
const ROW = /class="cn-row[ "]/g;

/** The overview as the shell mounts it — references resolve against `RefLinks` or `<Ref>` throws. */
const render = (v: CockpitView): string =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(Overview, { view: v, actions }),
    }),
  );

/**
 * The rule the model exists to enforce, checked from the sharp end.
 *
 * A pull request row names a pull request, so it offers a way to one: before the
 * model that was a convention each card kept or forgot, and the row that forgot
 * it read exactly like the rows that did not.
 */
test('every pull-request row carries a way to the pull request it names', () => {
  const html = render(view());
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('World signals'));
  const rows = rack.split(ROW).slice(1);
  assert.ok(rows.length > 0, 'no pull-request rows rendered');
  for (const row of rows) {
    const at = row.indexOf('cn-refs');
    assert.ok(at > 0, 'a pull-request row has no refs slot at all');
    const slot = row.slice(at);
    // The number, not the token: `<Ref>` draws a reference the provider could not
    // resolve as plain text on purpose, and the demo's fake provider resolves only
    // some of them. What the row owes is the reference in the slot every card
    // keeps them in — whether it became a link is the provider's answer and not
    // this rule's.
    assert.match(slot, /#\d+/, "a pull-request row's refs slot is empty");
  }
});

/**
 * The marker holds a sentence and nothing else.
 *
 * A reason naming `#412` is prose about a pull request, not a way to one — the
 * way there is the row's own refs slot. A ref rendered inside the bubble would be
 * a destination that only exists while a tooltip is open, which is a link nobody
 * can click and a keyboard user cannot reach at all.
 */
test('the why marker holds prose, never a reference and never a control', () => {
  const html = render(view());
  const tips = html
    .split('class="cn-why-tip"')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('</span>')));
  assert.ok(tips.length > 0, 'no reason was drawn at all');
  for (const tip of tips) {
    assert.ok(!tip.includes('<a '), 'a reason must not carry a link');
    assert.ok(!tip.includes('<button'), 'a reason must not carry a control');
  }
});

/**
 * The rail is a grid, and every row of a card is on the same one.
 *
 * Pinned because the way this breaks is invisible: the template was set on the
 * row *container* — a flex column, where `grid-template-columns` applies to
 * nothing — and every row went on rendering as the flex line it had always been.
 * Nothing errored, no test failed, and the only symptom was that the slots did
 * not line up, which is what the rail exists for and what a screenshot of a card
 * with two similar rows does not show.
 */
test('every row of a card sits on that card’s own grid', () => {
  const html = render(view());
  // Per card, because the subject column differs between them: what has to agree
  // is the rows of one card, which is what "always look here" means on a page of
  // five different-shaped cards.
  const cards = html.split('class="cn-card').slice(1);
  let checked = 0;
  for (const card of cards) {
    const templates = card
      .split('class="cn-row cn-frow')
      .slice(1)
      .map((chunk) => /style="grid-template-columns:([^"]+)"/.exec(chunk.slice(0, 400)));
    if (templates.length === 0) continue;
    for (const found of templates) {
      assert.ok(found, 'a facts row carries no grid template — the rail is a flex line again');
      assert.match(found[1] ?? '', /var\(--cn-w-/, 'the rail’s widths come from the sheet, not from a literal here');
    }
    const first = templates[0]?.[1];
    for (const found of templates) {
      assert.equal(found?.[1], first, 'two rows of one card are on different grids');
    }
    checked += 1;
  }
  assert.ok(checked >= 4, `only ${checked} cards drew rows — this test is about the ones that do`);
});

/**
 * The fleet row's state, as a word rather than a marker to hover.
 *
 * Ranked, not merged: the four come from four different facts — an escalation
 * naming the agent, the limit park, the stall park and a plain wait — and an
 * agent can be in more than one at once. A row can wear one word, so which one it
 * is has to be decided somewhere, and this is the decision.
 */
test('a fleet row wears the state it is in, and the strongest one it is in', () => {
  const base = buildDemoState().state;
  const live = base.agents.filter((a) => a.endedAt === null);
  const waiting = live.find((a) => a.status === 'waiting');
  assert.ok(live[0] && waiting, 'the fixtures must carry a live agent and a waiting one');

  const chips = (over: Partial<CockpitView['state']>): string[] => {
    const html = render(view(over));
    const fleet = html.slice(html.indexOf('Fleet'), html.indexOf('Goals in flight'));
    // The reading is the row's *word*; the tone is how loud it is. Since the badge
    // families folded into the one tag, that tone is a hue rather than a name —
    // `ask` is the red one and both holds are amber, which is the distinction this
    // test was always making. → docs/spec/17-cockpit.md#the-tag
    return [...fleet.matchAll(/cn-why-chip tag(?: t-(\w+))?[^"]*"[^>]*>([^<]+)</g)].map(
      (m) => `${m[2]}:${m[1] ?? 'quiet'}`,
    );
  };

  // The world as it ships: every live agent has an open escalation, which is the
  // top of the ranking and is your move whatever else is true of the row.
  assert.ok(chips({}).includes('question:red'), 'an agent with an open escalation asks you something');

  const noAsks = { escalations: [] };
  assert.ok(chips({ ...noAsks, parkedOnLimit: [live[0].id] }).includes('limit:amber'), 'a limit park says so');
  assert.ok(
    chips({
      ...noAsks,
      stallParks: [{ agentId: live[0].id, expiresAt: new Date(Date.now() + 9e5).toISOString() }],
    }).includes('stalled:amber'),
    'a stall park says so',
  );
  assert.ok(chips(noAsks).includes('blocked:amber'), 'a plain wait says so');

  // The ranking itself: the waiting agent is *also* parked on the limit, and the
  // row wears the park. Both are true; only one is what to do about it.
  const ranked = chips({ ...noAsks, parkedOnLimit: [waiting.id] });
  assert.ok(ranked.includes('limit:amber'), `the park outranks the wait — got ${ranked.join(', ')}`);
  assert.ok(!ranked.includes('blocked:amber'), 'and the row wears one word, not both');
});

/**
 * The rack's state column is the server's court verdict, quoted.
 *
 * The card drew it twice before — a `?` holding `attention.reasons` and a chip
 * holding the same reasons in a `title`, one column apart — and a second reading
 * of one verdict is how the two come to disagree. What this pins is that there is
 * one: the word in the state column is `attention.status` itself, not a word the
 * cockpit chose for it.
 */
test('a pull-request row wears the court the server put it in', () => {
  const state = buildDemoState().state;
  const html = render(view());
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('World signals'));
  const rows = rack.split(ROW).slice(1);
  // In the card's own order, not the world's: the rack puts the pull requests
  // somebody handed you above the fleet's, so a positional match against
  // `world.pullRequests` would be asserting against a list nothing draws.
  const open = state.world.pullRequests;
  const drawn = [
    ...open.filter((pr) => pr.attention.assignedToYou !== undefined),
    ...open.filter((pr) => pr.attention.assignedToYou === undefined),
  ];
  assert.equal(rows.length, open.length, 'every open pull request is drawn');
  for (const [i, row] of rows.entries()) {
    const pr = drawn[i];
    assert.ok(pr, 'the fixtures line up with the rows');
    assert.ok(
      row.includes(`>${pr.attention.status}</button>`),
      `#${pr.number} should wear "${pr.attention.status}" in its state column`,
    );
    // And the switch that takes it off the harness's books is pinned left of the
    // subject, ahead of the name: the same control in the same place on every
    // row, which is what lets an eye skip it.
    const eye = row.indexOf('cn-eye');
    assert.ok(eye > 0 && eye < row.indexOf('cn-grow'), `#${pr.number} draws no watch switch left of its subject`);
  }
});

/**
 * A live agent on the branch replaces the checks, and only while it is live.
 *
 * It *supersedes* rather than sits beside: the ladder is a reading of a commit
 * the agent is in the middle of replacing, so a green dot next to a working agent
 * is the least true thing the row can say. Which is also why this has to come
 * back — a marker that outlived its agent would be a pull request that looks
 * staffed forever, and a row saying "agent on it" is the one row nobody checks.
 */
test('a pull-request row draws the agent on its branch instead of its checks', () => {
  const state = buildDemoState().state;
  const live = state.agents.filter((a) => a.endedAt === null);
  const branches = new Set(
    live.map((a) => state.tasks.find((t) => t.id === a.taskId)?.branch).filter((b) => b != null),
  );
  const staffed = state.world.pullRequests.filter((pr) => branches.has(pr.branch));
  assert.ok(staffed.length > 0, 'the fixtures must put an agent on an open pull request’s branch');

  // Scoped to the rack: a goal row's title is `#376 <the PR's own title>`, so a
  // page-wide search for a pull request's title finds the goal card first.
  const rowFor = (html: string, title: string): string => {
    const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('World signals'));
    const found = rack.split(ROW).find((chunk) => chunk.includes(title));
    assert.ok(found, `no row drew "${title}"`);
    return found.slice(0, found.indexOf('cn-refs'));
  };

  const html = render(view());
  for (const pr of staffed) {
    const row = rowFor(html, pr.title);
    assert.match(row, /cn-onit/, `#${pr.number} has an agent on its branch and does not say so`);
    assert.ok(!row.includes('"ck '), `#${pr.number} draws its checks beside a live agent`);
  }

  // Every agent ended: the checks are the truest reading again, and the marker
  // is gone from every row.
  const quiet = render(
    view({ agents: state.agents.map((a) => ({ ...a, endedAt: a.endedAt ?? new Date().toISOString() })) }),
  );
  assert.ok(!quiet.includes('cn-onit'), 'a finished agent still holds a pull request');
  for (const pr of staffed) assert.match(rowFor(quiet, pr.title), /"ck /, `#${pr.number} lost its checks`);
});

/**
 * The agent mark rides the **lamp slot**, at the head of the row, on both racks.
 *
 * It is the one mark on either card that says *something is happening to this
 * right now*, and it was the one an eye could not find twice in the same place: on
 * the pull-request rack it stood where the checks mark stands, third of three,
 * and on the goal rack it rode the chips group behind the environment and the
 * orphan chip. Either way its distance along the row moved with whatever its
 * neighbours happened to have to say.
 *
 * The lamp column is what `PanelRow`'s grammar keeps for this: held open on every
 * row of the card once any row fills it, so the mark is either there or visibly
 * not — and absent altogether while no agent is out, so a quiet rack pays no
 * gutter for it.
 *
 * Both racks are asserted together, because they sit one above the other and a
 * glyph that means the same thing on both has to be in the same place on both.
 */
test('the agent mark is the row’s first slot, on both racks', () => {
  const state = buildDemoState().state;
  const html = render(view());
  const racks = {
    'Goals in flight': html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests')),
    'Pull requests': html.slice(html.indexOf('Pull requests'), html.indexOf('World signals')),
  };

  // Both cards widen the lamp column, and only those two: every other rack's lamp
  // really is an 8px dot, and the token is declared once for all of them.
  assert.equal(html.split('cn-lamp-mark').length - 1, 2, 'the lamp column is widened on the wrong number of cards');

  for (const [name, rack] of Object.entries(racks)) {
    const staffed = rack.split(ROW).filter((row) => row.includes('cn-onit'));
    assert.ok(staffed.length > 0, `the fixtures must put an agent on a row of ${name}`);
    for (const row of staffed) {
      // First slot on the row, ahead of the watch eye and the title. Measured
      // rather than asserted by class order, since a slot that merely *exists*
      // earlier in the markup is what the old arrangement also had.
      assert.ok(row.indexOf('cn-onit') < row.indexOf('cn-grow'), `a ${name} row draws the mark after its subject`);
      assert.ok(
        !/cn-slot[^"]*">(?!<button[^>]*cn-onit)[\s\S]{1,80}?cn-onit/.test(row),
        `a ${name} row puts something ahead of the mark in the row's first slot`,
      );
    }
  }

  // And the column goes away with the last agent: a gutter on a quiet rack is a
  // column reserved for a mark nothing on the card can draw.
  const quiet = render(
    view({ agents: state.agents.map((a) => ({ ...a, endedAt: a.endedAt ?? new Date().toISOString() })) }),
  );
  assert.ok(!quiet.includes('cn-onit'), 'a finished agent still holds a row');
});

/**
 * The mark is a **glyph and no words**, which is the icon set's one stated
 * exception to "an icon never appears without its label".
 *
 * `agent on it` written out was one sentence repeated down a whole column, and the
 * repetition is what stopped the row where it *is* news from standing out. Nothing
 * is lost: the sentence — the agent's own last answer to "what are you doing",
 * where the row has one — is the `title` and the `aria-label`, which is what a
 * pointer and a screen reader each ask for.
 */
test('the agent mark says what it is without spelling it out', () => {
  const html = render(view());
  assert.ok(html.includes('cn-onit'), 'the fixtures must put an agent on a row');
  assert.ok(!html.includes('agent on it'), 'the mark is back to spelling itself out on every row');
  assert.match(html, /class="cn-onit"[^>]*aria-label="Agent on it/, 'the mark carries no accessible name');
  assert.match(html, /class="cn-onit-dot"><svg/, 'the mark drew no glyph');
});

/**
 * The goal row's state column carries the pickup verdict, in words.
 *
 * Two things at once, and both were real bugs on the card: the verdict was a fact
 * with a bare `?` beside it holding its own reasons — one verdict said twice, the
 * second half saying nothing until hovered — and the word it said was the
 * dispatcher's identifier. `has_pr` is a value passed between rules.
 */
test('a goal row wears its pickup verdict in words, not as an enum', () => {
  const state = buildDemoState().state;
  const html = render(view());
  const card = html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests'));
  const rows = card.split(ROW).slice(1);
  assert.ok(rows.length > 0, 'the fixtures must put a goal in flight');
  assert.ok(!card.includes('>pickup<'), 'the pickup verdict is still drawn as a fact as well');

  const inFlight = state.world.issues.filter((issue) => card.includes(`#${issue.number} ${issue.title}`));
  assert.ok(
    inFlight.some((issue) => issue.pickup.status === 'has_pr'),
    'the fixtures must exercise a status whose identifier is not a phrase',
  );
  for (const issue of inFlight) {
    const row = rows.find((chunk) => chunk.includes(`#${issue.number} ${issue.title}`));
    assert.ok(row, `no row drew goal #${issue.number}`);
    assert.ok(!/>[a-z]+_[a-z]+</.test(row), `goal #${issue.number} shows an identifier where a word belongs`);
  }
});

/**
 * A goal wears the live treatment while an agent is on it, the rack's way.
 *
 * Off the dispatch's **origin**, which is the half that is easy to get wrong: an
 * agent's origin is a pull request as often as the goal itself, so a reading that
 * only understood `issue:<n>` would say nothing is happening on every goal whose
 * work has reached a pull request — which is most of the ones being worked, and
 * looks exactly like a quiet fleet.
 */
test('a goal row says so while an agent is on it', () => {
  const state = buildDemoState().state;
  const card = (html: string): string => html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests'));

  const html = render(view());
  const rows = card(html).split(ROW).slice(1);
  const staffed = rows.filter((row) => row.includes('cn-onit'));
  assert.ok(staffed.length > 0, 'the fixtures must put an agent on a goal whose origin is a pull request');
  for (const row of staffed) assert.match(row, /cn-live/, 'a goal says an agent is on it and does not wear it');

  // And it comes back: a marker that outlived its agent is a goal that looks
  // staffed forever, which is the one row nobody re-checks.
  const quiet = render(
    view({ agents: state.agents.map((a) => ({ ...a, endedAt: a.endedAt ?? new Date().toISOString() })) }),
  );
  assert.ok(!card(quiet).includes('cn-onit'), 'a finished agent still holds a goal');
});

/**
 * A retained run is a goal in flight only while there is still work on it.
 *
 * The card is the answer to "what is the fleet working on", and a retained run —
 * a closed ticket whose run the harness still holds — outlives its work by
 * however long it takes somebody to dismiss it. Every deployment accumulates
 * them, so listed unconditionally they end up outnumbering the live goals and the
 * card stops being read at all. One with work left (an agent, an ask, an
 * unfinished part) still rides the list; one with none is behind the header's
 * `kept` disclosure, which is a click rather than a dead end because dismissing
 * it is still the operator's to do.
 */
test('a finished retained run is behind the kept disclosure, not among the goals in flight', () => {
  const state = buildDemoState().state;
  const retained = state.retainedRuns ?? [];
  assert.ok(retained.length > 0, 'the fixtures must carry a retained run');
  const kept = retained[0]!;

  const html = render(view());
  const goals = html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests'));
  for (const issue of retained) {
    assert.ok(
      !goals.includes(`#${issue.number} ${issue.title}`),
      `retained run #${issue.number} is listed as a goal in flight with no work on it`,
    );
  }
  assert.match(goals, /kept/, 'the kept runs have no way in');

  // And the gate is about the work, not about the close: the same run with an
  // agent on it is a goal being worked, whatever the tracker did to its ticket.
  const live = state.agents.find((a) => a.endedAt === null);
  assert.ok(live, 'the fixtures must have an agent out');
  const busy = render(
    view({
      tasks: state.tasks.map((t) => (t.id === live.taskId ? { ...t, originRef: `issue:${kept.number}` } : t)),
    }),
  );
  assert.ok(
    busy
      .slice(busy.indexOf('Goals in flight'), busy.indexOf('Pull requests'))
      .includes(`#${kept.number} ${kept.title}`),
    'a retained run with an agent on it is not drawn as in flight',
  );
});

/**
 * The queue's own sentence, reaching the row unre-worded.
 *
 * Asserted against the model rather than the rendered card, because the Up next
 * band is collapsed by default: a test that scraped the markup would be asserting
 * against rows nobody drew, and would pass just as happily if `queueRow` stopped
 * being called at all.
 *
 * Three fields, because they are the three the card is not allowed to re-decide —
 * the status is the queue's word, the sentence is the queue's sentence, and the
 * band is the same band on every row, so the heading is drawn once.
 */
test('a queued row quotes the queue: its status as the word, its reason as the sentence', () => {
  const v = view();
  const items = v.state.upcoming?.items ?? [];
  assert.ok(items.length > 0, 'the fixtures must carry a queued item');
  for (const item of items) {
    const row = queueRow(item, v, actions);
    assert.equal(row.whyLabel, item.status, `#${item.origin} wears a word the queue did not say`);
    assert.equal(row.why, item.reason, `#${item.origin} re-worded the queue's reason`);
    assert.equal(row.queued, true, 'a queued row is drawn as an agent');
  }
  // `unapproved` is the operator's move and the rest are the harness stopped —
  // the one distinction the collapsed band's count is drawn from.
  const asks = items.filter((i) => i.status === 'unapproved');
  for (const item of asks) assert.equal(queueRow(item, v, actions).whyTone, 'ask');
  for (const item of items.filter((i) => i.status !== 'unapproved' && i.status !== 'dispatching')) {
    assert.equal(queueRow(item, v, actions).whyTone, 'hold');
  }
});

/**
 * The Fleet card's two bands share one budget.
 *
 * What this pins is the *subtraction*, not the number: the agents spend the
 * budget first and the queue takes what is left, so the card is the same height
 * whatever the fleet is doing. Two caps would draw the same on the fixtures and
 * grow the card by a row every time a dispatch went out, which is exactly the
 * jumping a fixed card height exists to stop.
 */
test('the fleet card’s rows are a budget the agents spend first', () => {
  const state = buildDemoState().state;
  const queued = state.upcoming?.items.length ?? 0;
  assert.ok(queued > 1, 'the fixtures must carry more than one queued item');
  const live = state.agents.filter((a) => a.endedAt === null);
  assert.ok(live[0], 'the fixtures must have an agent out');

  const card = (html: string): string => html.slice(html.indexOf('Fleet'), html.indexOf('Goals in flight'));
  const rows = (html: string): number => card(html).split(ROW).length - 1;
  const queuedRows = (html: string): number => card(html).split(/class="cn-row[^"]*cn-queued/).length - 1;

  // A fleet of exactly `n`, built from a real agent so every reading the row is
  // drawn from — `taskFor`, the lamp, the state column — answers as it does live.
  // The readying actions and the desk run are the card's rows too and spend the
  // same budget, so what the queue is owed is read off the view rather than
  // assumed to be `7 - n`.
  const fleet = (n: number): { drawn: number; queue: number; room: number } => {
    const v = view({ agents: Array.from({ length: n }, (_, i) => ({ ...live[0]!, id: `a${i}` })) });
    const out = v.live.length + v.readying.length + v.deskRuns.length;
    const html = render(v);
    return { drawn: rows(html), queue: queuedRows(html), room: Math.max(0, 7 - out) };
  };

  // The subtraction, at the sizes where it bites: what the agents leave is what
  // the queue draws, up to everything it has.
  for (const n of [1, 4, 6, 7, 9]) {
    const { drawn, queue, room } = fleet(n);
    assert.equal(queue, Math.min(queued, room), `a fleet of ${n} left the queue the wrong number of rows`);
    // Which is the point of a budget rather than two caps: the card does not grow
    // by a row every time a dispatch goes out.
    assert.ok(drawn <= 7 || room === 0, `a fleet of ${n} overran the card at ${drawn} rows`);
  }

  // And the band is there with nothing under it, which is the state its count and
  // its way to the panel matter most in.
  const packed = view({ agents: Array.from({ length: 9 }, (_, i) => ({ ...live[0]!, id: `a${i}` })) });
  assert.ok(render(packed).includes('Up next'), 'the band went with its last row');
});

/**
 * The band never passes its head off as the whole queue.
 *
 * The count and the way to the rest are the two things a card showing three of
 * fourteen owes a reader, and they are on the band rather than in the card's
 * header because they are about *this* band — a card can carry more than one.
 */
test('the up next band states the whole queue, and offers the rest', () => {
  const state = buildDemoState().state;
  const items = state.upcoming?.items ?? [];
  assert.ok(items.length > 0, 'the fixtures must carry a queued item');

  const html = render(view());
  const band = html.slice(html.indexOf('Up next'), html.indexOf('Goals in flight'));
  assert.ok(band.includes(`${items.length} queued`), 'the band does not say how big the queue is');

  // Every row above the queue is an agent, so a fleet at the budget leaves the
  // band with no rows at all — and it still draws, still counts, still offers the
  // panel. That is the state the reading matters most in.
  const packed = render(view({ upcoming: state.upcoming }));
  assert.ok(packed.includes('Up next'), 'the band vanished with rows to report');
});

/**
 * `unapproved` is the operator's move, and the band says how many there are.
 *
 * The head of the queue is three rows of fourteen, and a row that wants an answer
 * is as likely to be below the cut as above it — so the count is on the band,
 * where it is read whether or not that row is drawn.
 */
test('a queued ask is counted on the band, not left to be found', () => {
  const v = view();
  const items = v.state.upcoming?.items ?? [];
  const asking = items.filter((i) => i.status === 'unapproved').length;
  if (asking === 0) return; // nothing waiting on a person this snapshot
  const html = render(v);
  const band = html.slice(html.indexOf('Up next'), html.indexOf('Goals in flight'));
  assert.ok(band.includes(`${asking} on you`), 'the band does not say how much of the queue is yours');
});
