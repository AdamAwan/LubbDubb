import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoApi } from '../web/src/demo/demoBackend.js';
import { shownFeatures } from '../web/src/components/FeatureBoard.js';
import { NOWHERE, placeQuery, readPlace } from '../web/src/cockpit/place.js';

test('a closed Feature is off the board until the operator brings it back', async () => {
  const board = await demoApi.getFeatures();
  const closed = board.features.filter((f) => f.state === 'closed').map((f) => f.number);
  assert.deepEqual(closed, [300], 'the demo carries one closed Feature');

  const hidden = shownFeatures(board, false);
  assert.ok(!hidden.features.some((f) => f.state === 'closed'), 'hidden by default');
  assert.equal(hidden.features.length, board.features.length - 1);

  assert.equal(shownFeatures(board, true).features.length, board.features.length, 'and back when asked');
});

test('showing closed Features is part of the address', () => {
  assert.equal(NOWHERE.featureClosed, false);
  const query = placeQuery({ ...NOWHERE, featureClosed: true });
  assert.match(query, /closed=1/);
  assert.equal(readPlace(query).featureClosed, true);
});
