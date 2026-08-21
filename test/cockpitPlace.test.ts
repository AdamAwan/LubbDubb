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
    at({ panel: 'findings' }),
    at({ panel: 'faults' }),
    at({ panel: 'launch' }),
    at({ panel: { ask: 'esc-9' } }),
    at({ plan: 'plan-395' }),
    at({ retro: 'issue:142' }),
    at({ scratchpad: 'issue:142' }),
    at({ hatch: 'pet_7f2a1c' }),
    at({ panel: 'pets', hatch: 'pet_7f2a1c' }),
    at({ tab: 'config' }),
    at({ tab: 'config', configTab: 'prompts', configGroup: 'Agents' }),
    at({ tab: 'insights' }),
    at({ tab: 'insights', insightsView: 'causes', insightsWindow: '24h' }),
    at({ tab: 'insights', insightsWindow: 'all' }),
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
  const place = at({ tab: 'insights', goal: 'issue:142', insightsView: 'trend' });
  assert.equal(placeQuery(readPlace(placeQuery(place))), placeQuery(place));
});

// The ask panel carries an opaque id, and the goal ref carries a colon.
test('ids and refs survive encoding', () => {
  const place = at({ panel: { ask: 'esc:1&2=3' }, goal: 'issue:142' });
  assert.ok(!placeQuery(place).includes('&2=3'));
  assert.deepEqual(readPlace(placeQuery(place)), place);
});

// The tab's folds are a place, not a `useState`: stepping back into it has to
// restore the same folded features, and a shared link has to show what the sender
// was looking at.
// The backlog tab was folded into tickets (#351). An unknown tab resolves to the
// overview, so without the alias every bookmark and shared link to it would land
// somewhere else with nothing saying so.
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
