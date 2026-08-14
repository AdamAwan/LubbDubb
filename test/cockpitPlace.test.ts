import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOWHERE, placeQuery, readPlace, type Place } from '../web/src/cockpit/place.js';

const at = (over: Partial<Place> = {}): Place => ({ ...NOWHERE, ...over });

test('the overview with nothing open is a bare URL', () => {
  assert.equal(placeQuery(NOWHERE), '');
  assert.deepEqual(readPlace(''), NOWHERE);
  assert.deepEqual(readPlace('?'), NOWHERE);
});

test('every place round-trips through the query string', () => {
  const places: Place[] = [
    at({ tab: 'backlog' }),
    at({ tab: 'work' }),
    at({ goal: 'issue:142' }),
    at({ tab: 'backlog', goal: 'issue:142', agent: 'agent-7' }),
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

// The backlog's folds are a place, not a `useState`: stepping back into the
// backlog has to restore the same folded features, and a shared link has to show
// what the sender was looking at.
test('folded backlog features round-trip, deduplicated and sorted', () => {
  const place = at({ tab: 'backlog', collapsed: [12, 3] });
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
