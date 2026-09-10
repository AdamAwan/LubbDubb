import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconnectWatch } from '../web/src/cockpit/reconnect.js';

test('the first open is not a reconnect', () => {
  const rejoined = reconnectWatch();
  assert.equal(rejoined(true), false);
});

test('coming back after a drop is a reconnect, once', () => {
  const rejoined = reconnectWatch();
  rejoined(true);
  assert.equal(rejoined(false), false);
  assert.equal(rejoined(true), true);
  assert.equal(rejoined(true), false);
});

test('each drop earns its own re-read', () => {
  const rejoined = reconnectWatch();
  rejoined(true);
  for (let i = 0; i < 3; i += 1) {
    rejoined(false);
    assert.equal(rejoined(true), true);
  }
});

test('a burst of drops is still one reconnect', () => {
  const rejoined = reconnectWatch();
  rejoined(true);
  rejoined(false);
  rejoined(false);
  assert.equal(rejoined(true), true);
});
