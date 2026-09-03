import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../web/src/api.js';

test('plan history keeps a user-provided plan id inside its path segment', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return { ok: true, status: 200, json: async () => ({ revisions: [], diff: null, pending: null }) } as Response;
  }) as typeof fetch;

  try {
    await api.getPlanHistory('../state');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(urls, ['/api/plans/..%2Fstate/history']);
});
