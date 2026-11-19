import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';

const AT = '2026-01-01T00:00:00.000Z';

test('the latest local validation is the newer of two requested in the same millisecond', () => {
  const store = new Store(':memory:', () => AT);
  try {
    for (let i = 0; i < 20; i++) {
      store.localValidations.createLocalValidation({ originRef: 'issue:1', runId: `r${i}`, ref: 'b', commit: `${i}` });
      assert.equal(store.localValidations.latestLocalValidation('issue:1')?.commit, `${i}`);
    }
  } finally {
    store.close();
  }
});

test('the current local run is the newer of two begun in the same millisecond', () => {
  const store = new Store(':memory:', () => AT);
  try {
    for (let i = 0; i < 20; i++) {
      const run = store.localRuns.beginLocalRun({
        originRef: `issue:${i}`,
        ref: 'b',
        dir: '/x',
        commit: 'c',
        url: null,
      });
      assert.equal(store.localRuns.currentLocalRun()?.id, run.id);
      store.localRuns.setLocalRunStatus(run.id, 'stopped');
    }
  } finally {
    store.close();
  }
});
