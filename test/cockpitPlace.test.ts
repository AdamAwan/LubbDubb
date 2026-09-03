import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIVE_WORK,
  NOWHERE,
  placeQuery,
  readPlace,
  statePick,
  widenedFor,
  type Place,
} from '../web/src/cockpit/place.js';
import { GOAL_SECTIONS } from '../web/src/view/goalPage.js';

const at = (over: Partial<Place> = {}): Place => ({ ...NOWHERE, ...over });

test('the overview with nothing open is a bare URL', () => {
  assert.equal(placeQuery(NOWHERE), '');
  assert.deepEqual(readPlace(''), NOWHERE);
  assert.deepEqual(readPlace('?'), NOWHERE);
});

test('every place round-trips through the query string', () => {
  const places: Place[] = [
    at({ tab: 'tickets' }),
    at({ tab: 'tickets', ticketTracking: 'frozen', ticketState: 'In Review' }),
    at({ tab: 'tickets', ticketFeature: 812, ticketGroup: 'flat', ticketOrder: 'changed' }),
    at({ tab: 'tickets', ticketFeature: 'none' }),
    at({ tab: 'tickets', ticketView: 'card' }),
    at({ tab: 'tickets', ticketView: 'card', ticketColumns: ['Closed', 'Removed'] }),
    at({ tab: 'tickets', ticketColumns: ['Removed'] }),
    at({ panel: 'record' }),
    at({ goal: 'issue:142' }),
    at({ tab: 'tickets', goal: 'issue:142', agent: 'agent-7' }),
    at({ tab: 'obstacles' }),
    at({ tab: 'obstacles', obstacle: 'obs_abc' }),
    at({ tab: 'obstacles', obstacle: 'obs_abc', obstacleEnded: true }),
    at({ panel: 'faults' }),
    at({ panel: 'launch' }),
    at({ panel: { ask: 'esc-9' } }),
    at({ plan: 'plan-395' }),
    at({ retro: 'issue:142' }),
    at({ scratchpad: 'issue:142' }),
    at({ goal: 'issue:142', pr: 706 }),
    // The ladder, all three rungs at once: a pull request's page, over the goal it
    // was reached from, over the tab the goal was reached from. Stepping back has
    // to restore all three, which is the whole reason the pull request is a field
    // beside the goal rather than a value of it.
    at({ tab: 'tickets', goal: 'issue:142', pr: 706, agent: 'agent-7' }),
    at({ goal: 'issue:142', reviewPack: 684 }),
    at({ goal: 'issue:142', reviewPack: 684, reviewIdea: 'idea_V1StGXR8-Z5jdHi6' }),
    at({ goal: 'issue:142', reviewPack: 684, reviewIdea: 'all' }),
    at({ hatch: 'pet_7f2a1c' }),
    at({ panel: 'pets', hatch: 'pet_7f2a1c' }),
    at({ tab: 'config' }),
    at({ tab: 'config', configTab: 'prompts', configGroup: 'Agents' }),
    at({ tab: 'insights' }),
    at({ tab: 'insights', insightsView: 'causes', insightsWindow: '24h' }),
    at({ tab: 'insights', insightsWindow: 'all' }),
    at({ goal: 'issue:142', goalOpen: ['signals'], goalShut: ['ticket'] }),
  ];
  for (const place of places) assert.deepEqual(readPlace(placeQuery(place)), place, placeQuery(place));
});

/**
 * Every panel `ConsolePanel` admits survives the query string.
 *
 * Read off the type rather than listed here, because the list above is exactly
 * what this is guarding: `place.ts` keeps its own whitelist of panel names, and a
 * panel added to the type but not to that list does not merely lose its URL — the
 * place round-trips through the query string on every change, so the name is
 * parsed straight back to null and **the panel never opens at all**. That is a
 * dead control with no error anywhere, and it happened once (`build`).
 *
 * The `{ ask }` member is excluded: it carries an opaque row id in its own
 * parameter and is covered above.
 */
test('every panel the type admits round-trips through the URL', () => {
  const source = readFileSync('web/src/cockpit/actions.ts', 'utf8');
  const declaration = /export type ConsolePanel =([\s\S]*?);/.exec(source)?.[1];
  assert.ok(declaration, 'ConsolePanel is declared where this test looks for it');
  const panels = [...declaration.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(panels.length >= 5, `found ${panels.length} panels, which is too few to be the real list`);
  for (const panel of panels) {
    const place = at({ panel: panel as Place['panel'] });
    assert.deepEqual(readPlace(placeQuery(place)), place, `panel=${panel} is dropped by readPlace`);
  }
});

/**
 * Every section `ConfigTab` admits survives the query string.
 *
 * The sibling of the panel test above, and the same failure: `place.ts` keeps its
 * own `CONFIG_TABS` whitelist, so a section added to the type and forgotten there
 * is parsed straight back to `values` and **cannot be opened at all** — a tab in
 * the strip that draws the wrong body, with nothing red anywhere. Read off the
 * type rather than listed here, because the list is exactly what this guards.
 */
test('every config section the type admits round-trips through the URL', () => {
  const source = readFileSync('web/src/cockpit/actions.ts', 'utf8');
  const declaration = /export type ConfigTab =([\s\S]*?);/.exec(source)?.[1];
  assert.ok(declaration, 'ConfigTab is declared where this test looks for it');
  const sections = [...declaration.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(sections.length >= 5, `found ${sections.length} sections, which is too few to be the real list`);
  for (const section of sections) {
    const place = at({ tab: 'config', configTab: section as Place['configTab'] });
    assert.deepEqual(readPlace(placeQuery(place)), place, `section=${section} is dropped by readPlace`);
  }
});

// The one input to the cockpit an operator can type. A place that does not
// exist is the overview, never a throw and never a tab nothing draws.
test('a value that names no destination reads as the overview', () => {
  assert.equal(readPlace('?tab=nowhere').tab, 'overview');
  assert.equal(readPlace('?panel=nowhere').panel, null);
  assert.equal(readPlace('?tab=').tab, 'overview');
});

// An empty parameter names nothing, and a goal of `''` would draw a page for a
// ref no world holds rather than the tab the operator is on.
test('an empty parameter is an absent one', () => {
  assert.deepEqual(readPlace('?goal=&agent=&plan=&pad=&ask='), NOWHERE);
});

// The push in `useNavigation` is skipped when the query is unchanged, so two
// spellings of one place would be a history entry that goes nowhere.
test('a place has exactly one spelling', () => {
  // The tab is one that *lists* goals, because a goal under any other one is not a
  // place at all — see the nesting test below, which is the round trip's other half.
  const place = at({ tab: 'tickets', goal: 'issue:142', insightsView: 'trend' });
  assert.equal(placeQuery(readPlace(placeQuery(place))), placeQuery(place));
});

/**
 * A goal and a pull request hang off the tabs that list work, and off nothing else.
 *
 * The tab is what the crumb at the head of the situation area names, and a link
 * is one of the two ways into a place that names both — so the narrowing that
 * `selectGoal` does on a click has to happen here as well, or a saved
 * `?tab=insights&goal=…` draws a way out leading to a page that does not contain
 * the goal. → `docs/spec/17-cockpit.md#nesting`
 */
test('a goal or a pull request is read under a tab that could have led to it', () => {
  for (const tab of ['insights', 'obstacles', 'pets', 'config']) {
    assert.equal(readPlace(`?tab=${tab}&goal=issue:142`).tab, 'overview', `${tab} does not list goals`);
    assert.equal(readPlace(`?tab=${tab}&pr=706`).tab, 'overview', `${tab} does not list pull requests`);
  }
  // The three that do list work are left exactly as the link spelled them: the
  // operator really can have reached a goal from any of them.
  for (const tab of ['overview', 'tickets', 'features']) {
    assert.equal(readPlace(`?tab=${tab}&goal=issue:142`).tab, tab, `${tab} lists goals`);
  }
  // And the narrowing is conditional on there being something one rung in. A link
  // to Insights itself is a link to Insights.
  assert.equal(readPlace('?tab=insights').tab, 'insights');
});

// The ask panel carries an opaque id, and the goal ref carries a colon.
test('ids and refs survive encoding', () => {
  const place = at({ panel: { ask: 'esc:1&2=3' }, goal: 'issue:142' });
  assert.ok(!placeQuery(place).includes('&2=3'));
  assert.deepEqual(readPlace(placeQuery(place)), place);
});

// A fold on a page that is not open is not a place: a stray `?idea=` with no
// pack reads as nothing, and a hand-typed `?pack=` that names no number opens nothing.
test('an idea is carried only under a pack, and a pack is a positive integer', () => {
  assert.deepEqual(readPlace('?idea=idea_x'), NOWHERE);
  assert.deepEqual(readPlace('?pack=abc&idea=idea_x'), NOWHERE);
  assert.deepEqual(readPlace('?pack=0'), NOWHERE);
  assert.equal(readPlace('?pack=684&idea=idea_x').reviewIdea, 'idea_x');
  assert.equal(placeQuery(at({ reviewIdea: 'idea_x' })), '', 'an idea with no pack writes nothing');
});

// The tab's folds are a place, not a `useState`: stepping back into it has to
// restore the same folded features, and a shared link has to show what the sender
// was looking at.
// The backlog tab was folded into tickets (#351). An unknown tab resolves to the
// overview, so without the alias every bookmark and shared link to it would land
// somewhere else with nothing saying so.
test('a pull request page is a positive integer, or it is nowhere', () => {
  // The one input to the cockpit an operator can type. `?pr=main` is a place that
  // does not exist, and the answer to that is the page underneath it — never a
  // page drawn for NaN.
  assert.deepEqual(readPlace('?pr=main'), NOWHERE);
  assert.deepEqual(readPlace('?pr=0'), NOWHERE);
  assert.deepEqual(readPlace('?pr=-3'), NOWHERE);
  assert.equal(readPlace('?pr=706').pr, 706);
  assert.equal(readPlace('?goal=issue:142&pr=706').goal, 'issue:142', 'the goal underneath survives');
});

test('a link to the deleted backlog tab lands on the tickets tab', () => {
  assert.equal(readPlace('?tab=backlog').tab, 'tickets');
  assert.equal(readPlace('?tab=backlog&collapsed=3').collapsed[0], 3, 'and keeps the rest of the place');
  assert.equal(readPlace('?tab=nonsense').tab, 'overview', 'a tab that never existed is still the overview');
});

/**
 * The work tab went the same way, and lands in the same place.
 *
 * It is the weaker of the two aliases and deliberately so: tickets is not a
 * superset of the work tab, it has the half of it an operator *acted* on — the
 * unrecorded-work call-out — while the record itself is a panel now. A tab alias
 * cannot open a panel, and of the two halves this is the one a saved `?tab=work`
 * was overwhelmingly about.
 */
test('a link to the retired work tab lands where its triage went', () => {
  assert.equal(readPlace('?tab=work').tab, 'tickets');
  assert.equal(readPlace('?tab=work&goal=issue:142').goal, 'issue:142', 'and keeps the rest of the place');
});

/**
 * Knowledge, findings and lessons all named the claim store, which is gone. Every
 * saved link to any of them — a tab, a panel, or a panel with a `fact` id beside
 * it — lands on the obstacle board, which is the surface that replaced it.
 *
 * Without the alias an unknown tab or panel parses back to the overview with the
 * rest of the place still in the URL — a stranded link, and a silent one. The
 * panel arm is a panel alias rather than a tab one for `work`'s reason: an
 * explicit tab is the operator saying where they meant to be, and an alias must
 * never overrule one.
 */
test('links to the retired knowledge, findings and lessons surfaces land on the obstacle board', () => {
  assert.equal(readPlace('?tab=knowledge').tab, 'obstacles');
  assert.equal(readPlace('?panel=knowledge').tab, 'obstacles');
  assert.equal(readPlace('?panel=knowledge&fact=fact_abc').tab, 'obstacles', 'the fact id is simply dropped');
  assert.equal(readPlace('?panel=findings').tab, 'obstacles');
  assert.equal(readPlace('?panel=lessons').tab, 'obstacles');
  assert.equal(readPlace('?panel=findings').panel, null, 'and open no panel over it');
  assert.equal(
    readPlace('?panel=lessons&goal=issue:142').goal,
    'issue:142',
    'and keep the rest of the place they carried',
  );
  assert.equal(
    readPlace('?tab=tickets&panel=findings').tab,
    'tickets',
    'an explicit tab is the operator saying where they meant to be',
  );
});

// The two coarse axes swapped meaning in #351: `state` is the tracker's own word
// now, and the harness's reading moved to `tracking`. The alias is what keeps a
// saved `state=open` link asking the question it was asking before.
test('the old open/closed state parameter reads as the tracking axis', () => {
  assert.equal(readPlace('?tab=tickets&state=open').ticketTracking, 'live');
  assert.equal(readPlace('?tab=tickets&state=open').ticketState, 'any');
  assert.equal(readPlace('?tab=tickets&state=closed').ticketTracking, 'frozen');
  // A provider-native state is carried through untouched — the vocabulary is the
  // tracker's, and this file cannot hold the list to validate it against.
  assert.equal(readPlace('?tab=tickets&state=In%20Review').ticketState, 'In Review');
  assert.equal(readPlace('?tab=tickets').ticketTracking, 'live', 'and live is what a bare tab means');
});

test('folded features round-trip, deduplicated and sorted', () => {
  const place = at({ tab: 'tickets', collapsed: [12, 3] });
  assert.equal(placeQuery(place).includes('collapsed=3%2C12'), true);
  assert.deepEqual(readPlace(placeQuery(place)).collapsed, [3, 12]);
  // Folding A then B and B then A are one place, or the back button would have an
  // entry that goes nowhere.
  assert.equal(placeQuery(at({ collapsed: [3, 12] })), placeQuery(at({ collapsed: [12, 3] })));
});

// Nothing folded is the default, so it is a bare URL rather than an empty list.
test('no folded feature writes no parameter', () => {
  assert.equal(placeQuery(at({ collapsed: [] })), '');
  assert.deepEqual(readPlace('?collapsed=').collapsed, []);
});

// The one input an operator can type. A `NaN` here would fold a heading that
// does not exist, and there is nothing on screen to say why.
test('a hand-edited fold list drops what is not an issue number', () => {
  assert.deepEqual(readPlace('?collapsed=4,abc,-1,0,4,7.5,9').collapsed, [4, 9]);
});

/**
 * The other half of the round trip, and the half that fails silently.
 *
 * A filter reaching the URL is only the first leg: the panel is *told* where it
 * is through the view model, so a `ticket*` field the hook never forwards is
 * defaulted by `buildViewModel` and the control draws its default no matter what
 * the place says. The button then updates the address bar, changes no highlight
 * and re-reads no list — which happened to `tracking`, `feature` and `group` at
 * once, with nothing red.
 *
 * Read off `Place` rather than listed here, for the same reason as the panels
 * above: the list is what is being guarded.
 */
test('every ticket filter on the place is forwarded into the view model', () => {
  const place = readFileSync('web/src/cockpit/place.ts', 'utf8');
  const fields = [...place.matchAll(/^ {2}(ticket[A-Za-z]+):/gm)].map((m) => m[1]!);
  assert.ok(fields.length >= 6, `found ${fields.length} ticket filters, which is too few to be the real list`);
  const hook = readFileSync('web/src/cockpit/useCockpit.ts', 'utf8');
  for (const field of fields) {
    assert.ok(hook.includes(`${field}: place.${field},`), `${field} never reaches buildViewModel`);
  }
});

/** A facet as the route ships one — the count over the whole mirror, and how much of it is live. */
const facet = (state: string, count: number, live: number) => ({ state, count, live, pickup: false });

/**
 * The forward rule, restated here rather than assumed: the widening happens on
 * exactly the picks the `live` count says are unreachable, and on no other.
 */
test('a state with nothing live widens the tracking axis, and a state with live rows does not', () => {
  assert.deepEqual(statePick(facet('Closed', 68, 0), 'live'), { state: 'Closed', tracking: 'any' });
  assert.deepEqual(statePick(facet('Active', 9, 9), 'live'), { state: 'Active' });
  assert.deepEqual(statePick(facet('Closed', 68, 0), 'frozen'), { state: 'Closed' });
  assert.deepEqual(statePick(null, 'any'), { state: 'any' });
});

/**
 * And the inverse, which is the bug: after the widening the tab has to be able to
 * say which control moved, or the filter set it starts on is the one it cannot
 * offer back (issue #418).
 */
test('the tab can name the state its tracking axis is widened for', () => {
  const states = [facet('Closed', 68, 0), facet('Active', 9, 9)];
  assert.equal(widenedFor('Closed', 'any', states)?.state, 'Closed', 'the pick that widened it is named');
  assert.equal(widenedFor('Active', 'any', states), null, 'a state with live rows never widened anything');
  assert.equal(widenedFor('Closed', 'live', states), null, 'and a narrowed axis is not a widened one');
  assert.equal(widenedFor('any', 'any', states), null, 'nor is the whole history with no state picked');
  assert.equal(widenedFor('Closed', 'any', []), null, 'a state the facets do not know is left alone');
});

/**
 * The way back is the *pair*: narrowing to `live` while a closing state is still
 * picked is the empty list the widening exists to avoid. Read off `NOWHERE`, so it
 * cannot drift from the default it offers back.
 */
test('the way back out of a widening is the view the tab lands on', () => {
  assert.deepEqual(LIVE_WORK, { tracking: 'live', state: 'any' });
  assert.deepEqual({ ...NOWHERE, ticketTracking: LIVE_WORK.tracking, ticketState: LIVE_WORK.state }, NOWHERE);
  const back = { ...at({ tab: 'tickets' }), ticketTracking: LIVE_WORK.tracking, ticketState: LIVE_WORK.state };
  assert.equal(placeQuery(back), '?tab=tickets', 'and it is the bare tab, not a second spelling of it');
});

/**
 * `.tsx` is a module no test can import, and the two halves of this are useless
 * apart: a `widenedFor` nothing reads is a band that never draws, and a band with
 * no `LIVE_WORK` on it is the dead end being fixed.
 */
test('the tickets panel reads the widening back and offers the way out of it', () => {
  const panel = readFileSync('web/src/components/TicketsPanel.tsx', 'utf8');
  assert.match(panel, /widenedFor\(query\.state, query\.tracking, states\)/);
  assert.match(panel, /onQuery\(LIVE_WORK\)/);
  assert.match(panel, /className="tickets-widened"/);
});

test('the table is the default view, so it costs no query parameter', () => {
  assert.equal(placeQuery(at({ tab: 'tickets' })), '?tab=tickets');
  assert.equal(readPlace('?tab=tickets').ticketView, 'table');
  // An unknown view resolves to the default rather than to nothing, like every other
  // validated parameter here.
  assert.equal(readPlace('?tab=tickets&view=kanban').ticketView, 'table');
});

test('hidden columns are the exception, so an untouched board is a bare URL', () => {
  // Hidden rather than shown, for `collapsed`'s reason: the default is the empty
  // list, and a state that appears in the tracker later shows up on its own rather
  // than being invisibly excluded by a list written before it existed.
  assert.equal(placeQuery(at({ tab: 'tickets', ticketView: 'card' })), '?tab=tickets&view=card');
  assert.deepEqual(readPlace('?tab=tickets').ticketColumns, []);
});

test('hidden columns have one spelling, so hiding A then B is not a second place', () => {
  const one = placeQuery(at({ tab: 'tickets', ticketColumns: ['Removed', 'Closed'] }));
  const other = placeQuery(at({ tab: 'tickets', ticketColumns: ['Closed', 'Removed'] }));
  assert.equal(one, other, 'sorted on the way out, or the two would push a history entry going nowhere');
  assert.deepEqual(readPlace(one).ticketColumns, ['Closed', 'Removed']);
});

test('a blank entry in the hidden list is dropped rather than hiding a nameless column', () => {
  // The separator is the one character a tracker's state word may not contain here.
  // Encoding it would be a second grammar in the address bar; dropping the empty
  // part is the same treatment every other junk value gets.
  assert.deepEqual(readPlace('?tab=tickets&hide=Closed,,%20%20,Removed').ticketColumns, ['Closed', 'Removed']);
});

/**
 * Every foldable section of the goal page survives the query string, in both
 * directions.
 *
 * Read off {@link GOAL_SECTIONS} rather than listed here, for the panel test's
 * reason: `place.ts` validates the two lists against that union, so a section
 * added to the page and not to it writes a parameter that is parsed straight back
 * to nothing — the fold works until the next place change, then springs back.
 *
 * Both lists, because neither is the default: where a card starts is a reading of
 * how far the goal has got, and only `?shut=` can say the operator folded one the
 * goal's own progress would have opened.
 */
test('every foldable goal section round-trips, opened or folded', () => {
  for (const section of GOAL_SECTIONS) {
    const opened = at({ goal: 'issue:142', goalOpen: [section] });
    assert.deepEqual(readPlace(placeQuery(opened)), opened, section);
    const folded = at({ goal: 'issue:142', goalShut: [section] });
    assert.deepEqual(readPlace(placeQuery(folded)), folded, section);
  }
});

test('a hand-edited fold list drops a section that does not exist', () => {
  const place = readPlace('?goal=issue:142&open=ticket,nonesuch&shut=signals,nonesuch');
  assert.deepEqual(place.goalOpen, ['ticket']);
  assert.deepEqual(place.goalShut, ['signals']);
});
