import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePoolTransport } from '../src/integrations/fake/fakePool.js';
import { poolPackPath } from '../src/pool/document.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { reviewPackCompanionPath } from '../src/reviewPacks/companion.js';
import { packOrigin } from '../src/reviewPacks/origins.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import type { Agent, PoolPackDocument } from '../src/types.js';
import type { ReviewPackPayload, ReviewPackSharing } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const FLEET = 'alice@acme-api';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' import x from "x";',
  '+import y from "y";',
  ' ',
  ' export const a = 1;',
  '',
].join('\n');

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(over: { closedPrWindowMs?: number; transport?: FakePoolTransport } = {}): {
  system: System;
  transport: FakePoolTransport;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-share-'));
  const transport = over.transport ?? new FakePoolTransport();
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
      maxConcurrentAgents: 3,
      fleetId: FLEET,
      pool: { project: 'acme-api' } as never,
      ...(over.closedPrWindowMs === undefined ? {} : { closedPrWindowMs: over.closedPrWindowMs }),
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver().setDiff('main', HEAD, DIFF),
      backend: new FakePtyBackend(),
      poolTransport: transport,
      errorMirror: () => {},
      reapProcessTree: async () => {},
    },
  );
  return { system, transport };
}

function agentOn(system: System, originRef: string): Agent | undefined {
  const tasks = new Set(
    system.store
      .listTasks()
      .filter((t) => t.originRef === originRef)
      .map((t) => t.id),
  );
  return system.store.listAgents().find((a) => tasks.has(a.taskId) && a.status === 'running');
}

async function authored(system: System, code = 'line one\nline two\nline three\n'): Promise<void> {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202, res.body);
  await app.close();
  await system.reviewPacks.whenIdle();
  const author = agentOn(system, packOrigin(7));
  assert.ok(author, 'the author was spawned');
  mkdirSync(join(author!.cwd, 'src'), { recursive: true });
  writeFileSync(join(author!.cwd, 'src/unchanged.ts'), code);
  const session = system.mcp.session(author!.id);
  const submitted = (await session!.call('review_pack_submit', {
    headline: 'The module imports y.',
    summary: '**The import is the point.**',
    estimatedMinutes: 2,
    ideas: [
      {
        claim: 'a.ts gains a dependency on y.',
        title: 'One new import',
        anchors: [
          { kind: 'hunk', hunk: 'h1', gist: 'The import lands here.', mark: 'key' },
          { kind: 'region', path: 'src/unchanged.ts', start: 1, end: 2, gist: 'Unchanged, and should be.' },
        ],
        claims: [{ text: 'src/unchanged.ts does not import y.', provenance: { kind: 'inferred' } }],
      },
    ],
  })) as ToolResultText;
  assert.equal(submitted.isError, undefined, submitted.content[0]?.text);
}

async function openPrWithPack(over: Parameters<typeof build>[0] = {}): Promise<ReturnType<typeof build>> {
  const built = build(over);
  built.system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD });
  await built.system.harness.runCycle('manual');
  await authored(built.system);
  return built;
}

test('a pack is shared only when somebody shares it, and the document and its companion go out together', async () => {
  const { system, transport } = await openPrWithPack();
  const { app } = await buildApp(system);

  await system.pool!.run();
  assert.deepEqual(
    transport.published.filter((d) => d.kind === 'pack'),
    [],
    'nothing shares a pack for you',
  );
  const before = (await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' })).json() as ReviewPackPayload;
  assert.deepEqual(before.sharing, { available: true, share: null });

  const shared = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/share' });
  assert.equal(shared.statusCode, 202, shared.body);
  const asked = (shared.json() as ReviewPackSharing).share!;
  assert.equal(asked.headSha, HEAD);
  assert.equal(asked.publishedAt, null, 'the route does not do the network write');
  assert.equal(transport.published.filter((d) => d.kind === 'pack').length, 0);

  await system.pool!.run();
  const document = transport.published.find((d) => d.kind === 'pack') as PoolPackDocument | undefined;
  assert.ok(document, 'the next pulse carried it');
  assert.equal(document!.fleetId, FLEET);
  assert.equal(document!.prNumber, 7);
  assert.equal(document!.headSha, HEAD);
  assert.equal(document!.pack.headline, 'The module imports y.');

  assert.ok(transport.packs.has(poolPackPath(FLEET, 7)));
  const companion = transport.companions.get(reviewPackCompanionPath(FLEET, 7));
  assert.ok(companion, 'the companion was written beside it');
  assert.match(companion!, /^<!doctype html>/);
  assert.match(companion!, /The module imports y\./);

  const fetched = await transport.fetch();
  assert.equal(
    fetched.some((entry) => entry.text.includes('"kind": "pack"')),
    false,
    'the pack is never fetched back',
  );
  assert.deepEqual(system.store.listObstacles(), [], 'a shared pack files nothing');
  assert.equal(system.store.listErrors().length, 0);

  const after = (await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' })).json() as ReviewPackPayload;
  assert.ok(after.sharing.share!.publishedAt, 'the read says it is in the pool');
  await app.close();
  system.store.close();
});

test('the secret backstop runs over the embedded code, refuses, names the line, and rewrites nothing', async () => {
  const { system, transport } = await openPrWithPack();
  const packed = system.store.getCurrentReviewPack(7)!;
  packed.pack.ideas[0]!.anchors[1]!.code = ['line one', 'const token = "ghp_0123456789abcdefghij";'];
  system.store.recordReviewPack(packed.pack);

  const { app } = await buildApp(system);
  const refused = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/share' });
  assert.equal(refused.statusCode, 409);
  const error = (refused.json() as { error: string }).error;
  assert.match(error, /src\/unchanged\.ts:2/, 'the refusal names the line');
  assert.match(error, /a GitHub token/);
  assert.equal(error.includes('ghp_0123456789abcdefghij'), false, 'and never quotes the match');

  await system.pool!.run();
  assert.deepEqual(
    transport.published.filter((d) => d.kind === 'pack'),
    [],
  );
  assert.equal(system.store.getReviewPackShare(7), null, 'a refusal with somebody to tell writes no row');
  assert.ok(system.store.getCurrentReviewPack(7), 'and the local pack is untouched');
  await app.close();
  system.store.close();
});

test('a shared pack is pruned once its pull request has been closed long enough, and the local row is kept', async () => {
  const { system, transport } = await openPrWithPack({ closedPrWindowMs: 0 });
  const { app } = await buildApp(system);
  assert.equal((await app.inject({ method: 'POST', url: '/api/prs/7/review-pack/share' })).statusCode, 202);
  await system.pool!.run();
  assert.equal(transport.packs.size, 1);

  await system.pool!.run();
  assert.equal(transport.packs.size, 1);
  assert.equal(transport.unpublished.length, 0);

  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });
  await system.harness.runCycle('manual');
  await system.pool!.run();
  assert.deepEqual(transport.unpublished, [{ fleetId: FLEET, prNumber: 7 }]);
  assert.equal(transport.packs.size, 0, 'and the companion with it');
  assert.equal(transport.companions.has(reviewPackCompanionPath(FLEET, 7)), false);
  assert.equal(system.store.getReviewPackShare(7), null);
  assert.ok(system.store.getCurrentReviewPack(7), 'the fleet keeps its own record');

  await system.pool!.run();
  assert.equal(transport.unpublished.length, 1);
  await app.close();
  system.store.close();
});

test('sharing is refused with nowhere to publish to, and for a pull request with no pack', async () => {
  const { system } = await openPrWithPack();
  const { app } = await buildApp(system);
  const noPack = await app.inject({ method: 'POST', url: '/api/prs/8/review-pack/share' });
  assert.equal(noPack.statusCode, 409);
  assert.match((noPack.json() as { error: string }).error, /no review pack for #8/);
  await app.close();
  system.store.close();

  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-share-none-'));
  const poolless = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver(),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
      reapProcessTree: async () => {},
    },
  );
  assert.equal(poolless.pool, undefined);
  const { app: app2 } = await buildApp(poolless);
  const refused = await app2.inject({ method: 'POST', url: '/api/prs/7/review-pack/share' });
  assert.equal(refused.statusCode, 409);
  assert.match((refused.json() as { error: string }).error, /publishes to no pool/);
  await app2.close();
  poolless.store.close();
});
