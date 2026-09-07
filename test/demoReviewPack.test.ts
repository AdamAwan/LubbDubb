import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoApi } from '../web/src/demo/demoBackend.js';
import { buildDemoState } from '../web/src/demo/fixtures.js';

// → docs/spec/17-cockpit.md#demo-mode

test('every demo pack mark agrees with the pack the demo serves', async () => {
  const { state } = buildDemoState();
  for (const pr of state.world.pullRequests) {
    const reading = await demoApi.getReviewPack(pr.number);
    const standing =
      reading.kind === 'pack'
        ? pr.headSha === undefined
          ? 'unplaced'
          : reading.payload.pack.headSha === pr.headSha
            ? 'current'
            : 'stale'
        : reading.writing
          ? 'writing'
          : undefined;
    assert.equal(pr.pack, standing, `PR #${pr.number} wears ${String(pr.pack)}`);
  }
});

test('the demo pack is reachable from a mark', async () => {
  const { state } = buildDemoState();
  const marked = state.world.pullRequests.filter((pr) => pr.pack === 'current');
  assert.equal(marked.length, 1);
  const reading = await demoApi.getReviewPack(marked[0]!.number);
  assert.equal(reading.kind, 'pack');
});
