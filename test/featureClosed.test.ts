import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOWHERE, placeQuery, readPlace } from '../web/src/cockpit/place.js';

test('showing closed Features is part of the address', () => {
  assert.equal(NOWHERE.featureClosed, false);
  const query = placeQuery({ ...NOWHERE, featureClosed: true });
  assert.match(query, /closed=1/);
  assert.equal(readPlace(query).featureClosed, true);
});
