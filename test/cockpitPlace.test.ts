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
