import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsAppShell } from '../src/server/app.js';

test('deep links into the cockpit get the app shell', () => {
  for (const url of ['/', '/goals/42', '/agents', '/issues/ABC-1?tab=parts', '/pets/pip#top']) {
    assert.equal(wantsAppShell(url), true, url);
  }
});

test('a request for a file that is gone is a miss, not the shell', () => {
  for (const url of [
    '/assets/index-krbk1FXB.js',
    '/assets/index-pk2dTO2V.css',
    '/favicon.ico',
    '/assets/index-old.js?v=2',
  ]) {
    assert.equal(wantsAppShell(url), false, url);
  }
});

test('the API and socket prefixes keep their own 404', () => {
  assert.equal(wantsAppShell('/api/state'), false);
  assert.equal(wantsAppShell('/api/nope?x=1'), false);
  assert.equal(wantsAppShell('/ws'), false);
});
