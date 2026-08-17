import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOWHERE, placeQuery, readPlace, type Place } from '../web/src/cockpit/place.js';

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
    at({ tab: 'work' }),
    at({ goal: 'issue:142' }),
    at({ tab: 'tickets', goal: 'issue:142', agent: 'agent-7' }),
    at({ panel: 'findings' }),
    at({ panel: 'faults' }),
    at({ panel: 'output' }),
    at({ panel: 'launch' }),
    at({ panel: { ask: 'esc-9' } }),
    at({ plan: 'plan-395' }),
    at({ retro: 'issue:142' }),
    at({ scratchpad: 'issue:142' }),
    at({ settings: true }),
    at({ spend: true, reliability: true }),
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
  const place = at({ tab: 'work', goal: 'issue:142', spend: true });
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
