import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePoolTransport } from '../src/integrations/fake/fakePool.js';
import { poolPackPath } from '../src/pool/document.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import type { ReviewAttention, ReviewIdea, ReviewPack, ReviewRange } from '../src/types.js';
import type {
  ReviewCalibrationPayload,
  ReviewMarksPayload,
  ReviewPackPayload,
  ReviewPackSharing,
} from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Review packs, stage 7: the three things stage 6 left open.
 *
 * - The **attention overrides surfaced to the operator**, with the plumbing ratio
 *   beside them — one reading, `GET /api/review-calibration`, never shown to the
 *   checker and never fed into a prompt.
 * - A **`seen` mark on a false claim**, the third column on the same
 *   `review_marks` row, and the counter it makes possible.
 * - **Unshare**: the inverse of the share, immediate, over the pool's own arm.
 *
 * → docs/spec/31-review-packs.md#the-operators-reading,
 *   docs/spec/31-review-packs.md#whether-prominence-works,
 *   docs/spec/31-review-packs.md#unsharing-a-pack
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const FLEET = 'alice@acme-api';

function build(): { system: System; transport: FakePoolTransport } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-calib-'));
  const transport = new FakePoolTransport();
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      fleetId: FLEET,
      pool: { project: 'acme-api' } as never,
    }),
    {
      // A pack is never dispatched for here — the documents are seeded — but the
      // fake worktree manager still goes in: `config.repoRoot` defaults to the
      // checkout, and nothing in a test may cut a branch in it.
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver(),
      backend: new FakePtyBackend(),
      poolTransport: transport,
      errorMirror: () => {},
      reapProcessTree: async () => {},
    },
  );
  return { system, transport };
}

const hunk = (path: string, start: number, end: number): ReviewRange => ({ path, start, end });

function idea(over: {
  id: string;
  attention?: ReviewAttention | null;
  hunks: ReviewRange[];
  falseClaim?: boolean;
}): ReviewIdea {
  return {
    id: over.id,
    claim: `${over.id} does something`,
    title: over.id,
    cue: 'because',
    anchors: over.hunks.map((range) => ({
      kind: 'hunk' as const,
      range,
      code: ['+line'],
      gist: 'here',
      note: null,
      caption: null,
      mark: over.falseClaim === true ? ('false' as const) : null,
    })),
    claims: [
      {
        text: `${over.id} is true`,
        provenance: { kind: 'inferred' },
        verdict: over.falseClaim === true ? 'false' : 'true',
        evidence: 'read the tree',
        finding:
          over.falseClaim === true
            ? { headline: 'It is not', body: 'The tree disagrees.', step: 1, counter: null }
            : null,
      },
    ],
    attention: over.attention === undefined ? 'skim' : over.attention,
  };
}

function pack(prNumber: number, ideas: ReviewIdea[]): ReviewPack {
  return {
    schema: REVIEW_PACK_SCHEMA,
    prNumber,
    headSha: HEAD,
    headline: 'A change',
    summary: 'It changes things.',
    estimatedMinutes: 3,
    order: ideas.map((i) => i.id),
    ideas,
    witnessed: false,
    fake: 'nothing',
  };
}

test('the overrides and the plumbing ratio are one reading, and it never reaches the checker', async () => {
  const { system } = build();
  system.store.recordReviewPack(
    pack(7, [
      idea({ id: 'idea_a', attention: 'skim', hunks: [hunk('src/a.ts', 1, 4)] }),
      idea({ id: 'idea_b', attention: 'decide', hunks: [hunk('src/b.ts', 1, 4)] }),
      // The reserved id, and the one the ratio counts: two of this pack's four
      // hunks are hunks the author declined to explain.
      idea({ id: 'plumbing', attention: 'skim', hunks: [hunk('src/c.ts', 1, 2), hunk('src/d.ts', 1, 2)] }),
    ]),
  );
  const { app } = await buildApp(system);

  // A reviewer upgrades one label and downgrades nothing.
  const over = await app.inject({
    method: 'POST',
    url: '/api/prs/7/review-pack/ideas/idea_a/attention',
    payload: { attention: 'read' },
  });
  assert.equal(over.statusCode, 200, over.body);

  const read = await app.inject({ method: 'GET', url: '/api/review-calibration?window=all' });
  assert.equal(read.statusCode, 200, read.body);
  const { calibration } = read.json() as ReviewCalibrationPayload;

  assert.equal(calibration.packs, 1);
  assert.equal(calibration.overrides.labelled, 3);
  assert.equal(calibration.overrides.overridden, 1);
  assert.equal(calibration.overrides.upgrades, 1, 'skim → read is toward more scrutiny');
  assert.equal(calibration.overrides.downgrades, 0);
  assert.deepEqual(calibration.overrides.pairs, [{ from: 'skim', to: 'read', count: 1 }]);

  assert.equal(calibration.plumbing.hunks, 4);
  assert.equal(calibration.plumbing.plumbingHunks, 2);
  assert.equal(calibration.plumbing.ratio, 0.5);
  assert.equal(calibration.plumbing.worst[0]?.prNumber, 7);

  // The reading is the operator's, and nothing about it reaches an agent: the
  // pack the checker would be handed is untouched, and nothing was filed.
  assert.equal(system.store.getCurrentReviewPack(7)!.pack.ideas[0]!.attention, 'skim');
  assert.deepEqual(system.store.listObstacles(), []);
  await app.close();
  system.store.close();
});

test('a seen mark is its own column on the same row, and counts a merge nobody read', async () => {
  const { system } = build();
  system.store.recordReviewPack(
    pack(7, [
      idea({ id: 'idea_a', attention: 'read', hunks: [hunk('src/a.ts', 1, 4)], falseClaim: true }),
      idea({ id: 'idea_b', attention: 'read', hunks: [hunk('src/b.ts', 1, 4)], falseClaim: true }),
    ]),
  );
  // The durable record of the merge — the world drops a closed pull request, and
  // this reading is about merges that already happened.
  system.store.recordWorkGraph([{ ref: 'pr:7', kind: 'pr', title: 'Add y', status: 'merged', terminal: true }]);
  const { app } = await buildApp(system);

  // The reader takes one finding and leaves the other.
  await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/ideas/idea_a/read', payload: { read: true } });
  const seen = await app.inject({
    method: 'POST',
    url: '/api/prs/7/review-pack/ideas/idea_a/seen',
    payload: { seen: true },
  });
  assert.equal(seen.statusCode, 200, seen.body);
  const marks = (seen.json() as ReviewMarksPayload).marks;
  const marked = marks.find((m) => m.hunk.path === 'src/a.ts')!;
  assert.equal(marked.seen, true);
  // Each write names only its own column: taking the finding left the read mark
  // alone, and the override on the same row is untouched.
  assert.equal(marked.read, true, 'the read mark survived the seen write');
  assert.equal(marked.attention, null);

  const payload = (await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' })).json() as ReviewPackPayload;
  assert.equal(
    payload.marks.find((m) => m.hunk.path === 'src/b.ts'),
    undefined,
    'the other idea has no mark',
  );

  const { calibration } = (
    await app.inject({ method: 'GET', url: '/api/review-calibration?window=all' })
  ).json() as ReviewCalibrationPayload;
  assert.equal(calibration.prominence.falseClaims, 2);
  assert.equal(calibration.prominence.ideas, 2);
  assert.equal(calibration.prominence.seen, 1);
  assert.deepEqual(calibration.prominence.mergedUnseen, [7], 'it merged with one finding nobody took');

  // Taking the second one clears the count: the number is about findings nobody read.
  await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/ideas/idea_b/seen', payload: { seen: true } });
  const after = (
    await app.inject({ method: 'GET', url: '/api/review-calibration?window=all' })
  ).json() as ReviewCalibrationPayload;
  assert.deepEqual(after.calibration.prominence.mergedUnseen, []);
  assert.equal(after.calibration.prominence.seen, 2);
  await app.close();
  system.store.close();
});

test('unsharing takes the pack out on the next pulse, and the route does no network write', async () => {
  const { system, transport } = build();
  system.store.recordReviewPack(pack(7, [idea({ id: 'idea_a', hunks: [hunk('src/a.ts', 1, 4)] })]));
  const { app } = await buildApp(system);

  assert.equal((await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/share' })).statusCode, 202);
  await system.pool!.run();
  assert.ok(transport.packs.has(poolPackPath(FLEET, 7)), 'it is in the pool');

  const undone = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/unshare' });
  assert.equal(undone.statusCode, 202, undone.body);
  const sharing = undone.json() as ReviewPackSharing;
  assert.ok(sharing.share!.withdrawnAt, 'the row says it is on its way out');
  assert.equal(transport.unpublished.length, 0, 'the route did not do the network write');
  assert.ok(transport.packs.has(poolPackPath(FLEET, 7)), 'and the copy is still there until the pulse');

  await system.pool!.run();
  assert.deepEqual(transport.unpublished, [{ fleetId: FLEET, prNumber: 7 }]);
  assert.equal(transport.packs.has(poolPackPath(FLEET, 7)), false);
  // The share row is gone and the local pack is kept: it is the fleet's own record.
  assert.equal(system.store.getReviewPackShare(7), null);
  assert.ok(system.store.getCurrentReviewPack(7));
  assert.equal(system.store.listErrors().length, 0);

  // Unsharing again is not an error — the caller wanted it out of the pool, and it is.
  const again = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/unshare' });
  assert.equal(again.statusCode, 202);
  assert.equal((again.json() as ReviewPackSharing).share, null);
  await app.close();
  system.store.close();
});

test('a share the pool never carried is withdrawn outright, with nothing to unpublish', async () => {
  const { system, transport } = build();
  system.store.recordReviewPack(pack(7, [idea({ id: 'idea_a', hunks: [hunk('src/a.ts', 1, 4)] })]));
  const { app } = await buildApp(system);
  await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/share' });

  const undone = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/unshare' });
  assert.equal(undone.statusCode, 202);
  assert.equal((undone.json() as ReviewPackSharing).share, null, 'nothing landed, so nothing describes it');

  await system.pool!.run();
  assert.deepEqual(transport.unpublished, [], 'no commit is made to remove what was never there');
  assert.equal(transport.packs.has(poolPackPath(FLEET, 7)), false);
  await app.close();
  system.store.close();
});
