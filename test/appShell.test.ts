import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsAppShell } from '../src/server/app.js';

/*
 * The SPA fallback's whole job is telling a deep link apart from a file that is
 * gone. The second half is the one with a silent failure behind it — a stale
 * hashed chunk answered with `200 text/html` is a cockpit that does not start and
 * a server that logged nothing — so both directions are asserted here rather than
 * through `buildApp`: the tests run in a job with no `web/dist`, where the static
 * plugin is never registered and an injected request would prove nothing.
 */

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
