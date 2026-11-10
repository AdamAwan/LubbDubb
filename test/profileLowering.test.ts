import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerProfilePin } from '../src/intake/profilePin.js';
import type { IssueLabelInput } from '../src/sink/actionSink.js';

const MODELS = {
  profiles: {
    fast: { model: 'haiku', rank: 1, description: 'mechanical work' },
    standard: { model: 'sonnet', rank: 2, description: 'ordinary work' },
    deep: { model: 'opus', rank: 3, description: 'hard work' },
  },
  default: 'standard',
};

function harness(labels: string[]) {
  const writes: IssueLabelInput[] = [];
  const patched: { label: string; present: boolean }[] = [];
  const store = {
    verdicts: { getAppraisal: () => null, answerAppraisalProfile: () => false },
    world: {
      getWorldBaseline: () => ({ issues: [{ number: 7, labels }] }),
      patchWorldLabels: (p: { label: string; present: boolean }) => patched.push(p),
    },
    tickets: { patchTicketLabels: () => undefined },
  };
  const ctx = {
    store: store as never,
    sink: {
      setIssueLabel: (input: IssueLabelInput) => {
        writes.push(input);
        return Promise.resolve({ ok: true }) as never;
      },
    },
    labelPrefix: 'lubbdubb',
    agentModels: MODELS,
  };
  return { ctx, writes, patched };
}

test('a proposal cheaper than the standing profile is pinned without asking, and folded onto the world', async () => {
  const { ctx, writes, patched } = harness([]);
  assert.equal(await lowerProfilePin(ctx, 7, 'fast'), true);
  assert.deepEqual(
    writes.filter((w) => w.present).map((w) => w.label),
    ['lubbdubb-model-fast'],
  );
  assert.deepEqual(
    patched.filter((p) => p.present).map((p) => p.label),
    ['lubbdubb-model-fast'],
  );
});

test('a proposal deeper than, or equal to, what is standing writes nothing — it waits for the operator', async () => {
  for (const proposed of ['deep', 'standard']) {
    const { ctx, writes } = harness([]);
    assert.equal(await lowerProfilePin(ctx, 7, proposed), false);
    assert.deepEqual(writes, []);
  }
});

test("cheaper is measured against the ticket's own tag, not only the default", async () => {
  const { ctx } = harness(['lubbdubb-model-deep']);
  assert.equal(await lowerProfilePin(ctx, 7, 'standard'), true);
});
