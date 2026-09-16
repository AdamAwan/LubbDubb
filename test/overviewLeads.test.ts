import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { buildLeads } from '../web/src/console/overviews/leads.js';
import { repoText } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { FocusOverview, Look } = await import('../web/src/console/overviews/FocusOverview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function built(): CockpitView {
  const state = buildDemoState().state;
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
    overviewShape: 'focus',
  });
}

/* The clear state is what most of this module is about, so the queue is emptied
   by default and `needs()` hands back the demo's own asks where one is wanted —
   a hand-built row would be this file's own idea of a `NeedRow` rather than the
   shape `needsYou.ts` actually ships. */
function view(over: Partial<CockpitView> = {}): CockpitView {
  return { ...built(), needsYou: [], ...over };
}

function needs(): CockpitView['needsYou'] {
  return built().needsYou;
}

type Panel = React.FC<{ view: CockpitView; actions: CockpitActions }>;

function markup(v: CockpitView, what: Panel = FocusOverview): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(what, { view: v, actions }),
    }),
  );
}

/* The clear state is the whole point of the leads: an empty ask queue is not an
   empty deployment, and the sentence on its own left the operator nothing to do
   on the surface that exists to say what to do. */
test('an empty ask queue draws the leads rather than a sentence alone', () => {
  const v = view();
  const leads = buildLeads(v);
  assert.ok(leads.length > 0, 'the demo deployment has something worth a look');

  const html = markup(v);
  assert.match(html, /Nothing needs you\./);
  assert.match(html, /Worth a look/);
  for (const lead of leads) assert.ok(html.includes(lead.title), `${lead.key} is drawn`);
});

/* An approval is the operator's own act, so it leads: the order is what they can
   do something about, first. */
test('the pull requests nobody has approved come first', () => {
  const keys = buildLeads(view()).map((l) => l.key);
  assert.equal(keys[0], 'prs');
  assert.deepEqual(
    keys,
    ['prs', 'queued', 'reservoir', 'quiet', 'faults'].filter((k) => keys.includes(k as never)),
  );
});

/* The hue answers whose the reading is, and the goals quietly working their own
   plans are nobody's — so that lead wears none. */
test('a lead wears the tone its kind was given, and only where it has one', () => {
  const tones = new Map(buildLeads(view()).map((l) => [l.key, l.tone]));
  assert.equal(tones.get('prs'), 'amber');
  assert.equal(tones.get('faults'), 'red');
  if (tones.has('quiet')) assert.equal(tones.get('quiet'), null);
});

test('no lead is ever built with nothing in it', () => {
  for (const lead of buildLeads(view())) assert.ok(lead.count > 0, `${lead.key} counts something`);
});

/* Every lead and every thing it names has somewhere to go — a name with no way
   to it is the cockpit's most repeated bug. */
test('every lead and every named item carries a way there', () => {
  for (const lead of buildLeads(view())) {
    assert.ok(lead.go.length > 0, `${lead.key} has a control word`);
    assert.ok(lead.where.kind.length > 0, `${lead.key} has a where`);
    for (const item of lead.items) assert.ok(item.ref.length > 0 && item.where.kind.length > 0);
  }
});

/* An approval is the operator's own act and nothing else raises an ask for it, so
   the pull requests nobody has approved are what this lead is for. `approved` is
   optional on the wire: an unreported approval is an unknown, and folding it into
   `false` would claim every open pull request on a provider that does not report
   reviews. */
test('the pull request lead counts only what is reported unapproved', () => {
  const v = view();
  const lead = buildLeads(v).find((l) => l.key === 'prs');
  const unapproved = v.state.world.pullRequests.filter(
    (pr) => pr.approved === false && !v.agentOnBranch.has(pr.branch),
  );
  assert.equal(lead?.count ?? 0, unapproved.length);
  for (const item of lead?.items ?? []) {
    const pr = v.state.world.pullRequests.find((p) => `pr:${p.number}` === item.ref);
    assert.equal(pr?.approved, false, `${item.ref} is reported unapproved`);
  }
});

test('an approval the provider never reported is not an unapproved pull request', () => {
  const base = view();
  const prs = base.state.world.pullRequests.map((pr) => {
    const { approved: _approved, ...rest } = pr;
    return rest;
  });
  const v: CockpitView = { ...base, state: { ...base.state, world: { ...base.state.world, pullRequests: prs } } };
  assert.equal(
    buildLeads(v).find((l) => l.key === 'prs'),
    undefined,
  );
});

/* Longest-waiting first: the one sitting a week is the one worth naming. */
test('the pull request lead names its longest wait first', () => {
  const lead = buildLeads(view()).find((l) => l.key === 'prs');
  const waits = (lead?.items ?? []).flatMap((i) => (i.since === undefined ? [] : [Date.parse(i.since)]));
  assert.deepEqual(
    waits,
    [...waits].sort((a, b) => a - b),
  );
});

test('the reservoir lead counts the unwatched and nothing else', () => {
  const v = view();
  const lead = buildLeads(v).find((l) => l.key === 'reservoir');
  const unwatched = v.state.world.issues.filter((i) => i.pickup.status === 'unwatched').length;
  if (unwatched === 0) {
    assert.equal(lead, undefined);
    return;
  }
  assert.equal(lead?.count, unwatched);
  assert.ok((lead?.items.length ?? 0) <= 3, 'it names a few, not the list');
});

/* A goal an agent is out on is not a lead: it is the fleet working, which the
   surface has already said in its own first line. */
test('a goal with an agent on it is not a quiet goal', () => {
  const v = view();
  const quiet = buildLeads(v).find((l) => l.key === 'quiet');
  for (const item of quiet?.items ?? []) assert.equal(v.agentOnGoal.has(item.ref), false);
});

/* Nothing queued, nothing unwatched, nothing open, nothing recorded: the answer
   is to give the fleet work, not another reading. */
test('with nothing to find at all, the clear state offers the launch desk', () => {
  const base = view();
  const v: CockpitView = {
    ...base,
    upNext: [],
    state: {
      ...base.state,
      world: { ...base.state.world, issues: [], pullRequests: [] },
      errors: [],
    },
  };
  assert.deepEqual(buildLeads(v), []);

  const html = markup(v);
  assert.match(html, /Nothing to look at either/);
  assert.match(html, /Write a brief/);
  assert.doesNotMatch(html, /Worth a look/);
});

/* The fleet strip was drawn below the ask card and is above it now: below the
   fold is where a reading goes to be missed, and the flick-back it exists to
   remove survived it. → docs/spec/17-cockpit.md#what-the-fleet-is-doing-above-the-ask */
test('the fleet strip is drawn above the ask, on both states of the shape', () => {
  for (const [state, v] of [
    ['clear', view()],
    ['an ask', view({ needsYou: needs() })],
  ] as const) {
    const html = markup(v);
    const slots = html.indexOf('cn-ov-slots');
    const card = html.indexOf(state === 'clear' ? 'cn-ov-focus-clear' : 'cn-ov-focus-card');
    assert.ok(slots > 0, `the fleet strip is drawn (${state})`);
    assert.ok(card > 0, `the ask card is drawn (${state})`);
    assert.ok(slots < card, `the fleet strip is below the work again (${state})`);
  }
});

/* A panel above the ask is a second panel competing with the one the operator is
   meant to be reading, so the strip has none — while the ask card keeps its own,
   which is the one object on this surface anybody is being asked to act on. */
test('the fleet strip wears no panel and the ask card keeps one', () => {
  const css = repoText('web/src/console/console.css');
  const strip = /\.cn-ov-slots \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.ok(strip.length > 0, 'the fleet strip has no rule');
  for (const prop of ['border', 'background', 'padding']) {
    assert.ok(!strip.includes(`${prop}:`), `the fleet strip draws its own ${prop}`);
  }
  const card = /\.cn-ov-focus-card \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.ok(card.includes('border:'), 'the ask lost the one frame on this surface');
  assert.ok(card.includes('background:'), 'the ask card lost its ground');
});

/* The creatures come back inside the ask card, and what is dropped is the banner
   rather than the pets. → docs/spec/22-pets.md#the-focus-shapes-floor */
test('the pets are drawn on the ask card, without the banner', () => {
  const v = view({ needsYou: needs() });
  const html = markup(v);
  const pets = html.indexOf('cn-ov-focus-pets');
  const card = html.indexOf('cn-ov-focus-card');
  assert.ok(card >= 0 && pets > card, 'the creatures are not inside the ask card');
  assert.ok(html.includes('cn-viv-floor'), 'the card drew no creatures');
  assert.ok(!html.includes('cn-viv-bar'), 'the banner came along with them');
  assert.ok(!html.includes('counting since'), 'the date the banner carried came along with it');
});

/* Every creature keeps the control it had on the strip: an egg opens its own
   ceremony, anything else opens the panel. */
test('the pets on the card are still one control per creature', () => {
  const v = view({ needsYou: needs() });
  const html = markup(v);
  const placed = (v.state.pets?.pets ?? []).filter((p) => p.placed);
  assert.ok(placed.length > 0, 'the demo vivarium has creatures in it');
  const eggs = placed.filter((p) => p.openedAt === null).length;
  assert.equal((html.match(/class="cn-viv-egg"/g) ?? []).length, eggs);
  assert.equal((html.match(/class="cn-viv-pet"/g) ?? []).length, placed.length - eggs);
});

/* A deployment with the feature off ships no vivarium, and the card must draw no
   empty floor for one. */
test('no vivarium in the snapshot draws no floor on the card', () => {
  const base = view({ needsYou: needs() });
  const v: CockpitView = { ...base, state: { ...base.state, pets: null } };
  const html = markup(v);
  assert.ok(!html.includes('cn-ov-focus-pets'), 'an empty floor is drawn where there is no vivarium');
  assert.ok(html.includes('cn-ov-focus-card'), 'the ask itself still draws');
});

/* The leads were reachable only by emptying the queue, which made the one reading
   on this surface that says what *could* be done a panel a busy deployment never
   sees. They are the queue's last stop now.
   → docs/spec/17-cockpit.md#moving-along-the-queue */
test('the leads are a stop on the queue, after the asks', () => {
  const rows = needs();
  assert.ok(rows.length > 0, 'the demo deployment has asks');
  const html = markup(view({ needsYou: rows }));

  const pips = (html.match(/class="cn-ov-pip /g) ?? []).length;
  assert.equal(pips, rows.length + 1, 'the queue draws a pip per ask and one for the last stop');
  assert.match(html, /cn-ov-pip-look/, 'the last stop has no pip of its own');
  assert.match(html, new RegExp(`1 of ${rows.length + 1}`), 'the counter counts the last stop');
  assert.match(html, /what is worth a look is next|after this/, 'the ask says what follows it');
});

/* It is the end of the queue rather than a position among the asks: nothing on it
   is anybody's move, and an ask that is would sort behind it. */
test('the last stop draws the leads, and only from the last position', () => {
  const rows = needs();
  const html = markup(view({ needsYou: rows }));
  assert.doesNotMatch(html, /cn-ov-focus-look/, 'the last stop is drawn while an ask is under the cursor');

  const leads = buildLeads(view({ needsYou: rows }));
  assert.ok(leads.length > 0, 'the demo deployment has something worth a look');

  /* The cursor is local state, so the stop itself is rendered directly. */
  const stop = markup(view({ needsYou: rows }), Look);
  for (const lead of leads) assert.ok(stop.includes(lead.title), `${lead.key} is drawn on the last stop`);
  assert.match(stop, /Worth a look/);
});
