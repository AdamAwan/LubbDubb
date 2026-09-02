import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { checkOrigin, packOrigin } from '../src/reviewPacks/origins.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import type { Agent, ReviewPack } from '../src/types.js';
import type { ReviewMarksPayload, ReviewPackPayload } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { layMarks } from '../web/src/view/reviewPack.js';

/**
 * Review packs, stage 5: the reviewer's marks, through the two routes the page
 * writes them with. A mark is keyed to the hunks an idea owns and never to the
 * idea's id, so it survives the pack being rewritten and lands on whichever idea
 * owns the same hunks next time.
 * → docs/spec/31-review-packs.md#what-a-reviewer-does-is-not-part-of-the-pack
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

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
  'diff --git a/src/b.ts b/src/b.ts',
  'index 3333333..4444444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,2 +9,0 @@ const gone = 1;',
  '-const old = 2;',
  '',
].join('\n');

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-marks-'));
  return buildSystem(
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
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver().setDiff('main', HEAD, DIFF),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
      reapProcessTree: async () => {},
    },
  );
}

function agentOn(system: System, originRef: string): Agent | undefined {
  // The live agent on the origin: a second ask on the same pull request opens a
  // second task, and the first author's row is finished by then.
  const tasks = new Set(
    system.store
      .listTasks()
      .filter((t) => t.originRef === originRef)
      .map((t) => t.id),
  );
  return system.store.listAgents().find((a) => tasks.has(a.taskId) && a.status === 'running');
}

/** Ask, and have the author land a pack: an idea on h1 with a region, a region-only idea, and plumbing on h2. */
async function authored(
  system: System,
  titles = { first: 'One new import' },
): Promise<{ author: Agent; pack: ReviewPack }> {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202, res.body);
  await app.close();
  await system.reviewPacks.whenIdle();
  const author = agentOn(system, packOrigin(7));
  assert.ok(author, 'the author was spawned');
  mkdirSync(join(author!.cwd, 'src'), { recursive: true });
  writeFileSync(join(author!.cwd, 'src/unchanged.ts'), 'line one\nline two\nline three\n');
  const session = system.mcp.session(author!.id);
  assert.ok(session, 'the author has a live MCP credential');
  const submitted = (await session!.call('review_pack_submit', {
    headline: 'The module imports y.',
    summary: '**The import is the point.**',
    estimatedMinutes: 2,
    ideas: [
      {
        claim: 'a.ts gains a dependency on y.',
        title: titles.first,
        anchors: [
          { kind: 'hunk', hunk: 'h1', gist: 'The import lands here.', mark: 'key' },
          { kind: 'region', path: 'src/unchanged.ts', start: 1, end: 2, gist: 'Unchanged, and should be.' },
        ],
        claims: [{ text: 'src/unchanged.ts does not import y.', provenance: { kind: 'inferred' } }],
      },
      {
        claim: 'The context file is untouched.',
        title: 'Context only',
        anchors: [{ kind: 'region', path: 'src/unchanged.ts', start: 2, end: 3, gist: 'Shown for context.' }],
        claims: [{ text: 'Nothing here changed.', provenance: { kind: 'inferred' } }],
      },
      {
        id: 'plumbing',
        claim: 'The deletion carries nothing to review.',
        title: 'Dead code goes',
        anchors: [{ kind: 'hunk', hunk: 'h2', gist: 'An unused constant.' }],
        claims: [{ text: 'Nothing read old.', provenance: { kind: 'inferred' } }],
      },
    ],
  })) as ToolResultText;
  assert.equal(submitted.isError, undefined, submitted.content[0]?.text);
  return { author: author!, pack: system.store.getCurrentReviewPack(7)!.pack };
}

test('a mark rides the hunks an idea owns, each column its own, and the read lays it back on the idea', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD });
  await system.harness.runCycle('manual');
  const { pack } = await authored(system);
  const [idea, contextOnly] = pack.ideas;
  const { app } = await buildApp(system);

  // Read: one row per owned hunk — the region is not one — stamped with the pack's head.
  const read = await app.inject({
    method: 'POST',
    url: `/api/prs/7/review-pack/ideas/${idea!.id}/read`,
    payload: { read: true },
  });
  assert.equal(read.statusCode, 200, read.body);
  const marks = (read.json() as ReviewMarksPayload).marks;
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0]!.hunk, { path: 'src/a.ts', start: 1, end: 4 });
  assert.equal(marks[0]!.headSha, HEAD);
  assert.equal(marks[0]!.read, true);
  assert.equal(marks[0]!.attention, null);

  // The override writes its own column and leaves the other as it was.
  const over = await app.inject({
    method: 'POST',
    url: `/api/prs/7/review-pack/ideas/${idea!.id}/attention`,
    payload: { attention: 'decide' },
  });
  assert.equal(over.statusCode, 200, over.body);
  assert.deepEqual(
    (over.json() as ReviewMarksPayload).marks.map((m) => [m.read, m.attention]),
    [[true, 'decide']],
  );

  // The read route ships the same rows, and the renderer's lay-over puts them on the idea.
  const got = await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' });
  const payload = got.json() as ReviewPackPayload;
  const laid = layMarks(payload.pack, payload.marks);
  assert.deepEqual(laid.get(idea!.id), { read: true, attention: 'decide' });
  assert.deepEqual(laid.get('plumbing'), { read: false, attention: null });
  assert.deepEqual(laid.get(contextOnly!.id), { read: false, attention: null }, 'a walk of regions can carry no mark');

  // Clearing the override, and unreading, each leave the other column alone.
  const clear = await app.inject({
    method: 'POST',
    url: `/api/prs/7/review-pack/ideas/${idea!.id}/attention`,
    payload: { attention: null },
  });
  assert.deepEqual(
    (clear.json() as ReviewMarksPayload).marks.map((m) => [m.read, m.attention]),
    [[true, null]],
  );
  const unread = await app.inject({
    method: 'POST',
    url: `/api/prs/7/review-pack/ideas/${idea!.id}/read`,
    payload: { read: false },
  });
  assert.deepEqual(
    (unread.json() as ReviewMarksPayload).marks.map((m) => [m.read, m.attention]),
    [[false, null]],
  );
  await app.close();
  system.store.close();
});

test('the mark routes refuse by name: a bad body, no pack, no such idea, and an idea that owns no hunk', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD });
  await system.harness.runCycle('manual');
  const { pack } = await authored(system);
  const [idea, contextOnly] = pack.ideas;
  const { app } = await buildApp(system);

  const refusal = async (url: string, payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url, payload });
    return { status: res.statusCode, error: (res.json() as { error: string }).error };
  };
  assert.deepEqual(await refusal(`/api/prs/7/review-pack/ideas/${idea!.id}/read`, { read: 'yes' }), {
    status: 400,
    error: 'read must be true or false',
  });
  assert.deepEqual(await refusal(`/api/prs/7/review-pack/ideas/${idea!.id}/attention`, { attention: 'urgent' }), {
    status: 400,
    error: 'attention must be one of read, decide, skim, split, or null',
  });
  const noPack = await refusal(`/api/prs/8/review-pack/ideas/${idea!.id}/read`, { read: true });
  assert.equal(noPack.status, 404);
  assert.match(noPack.error, /no review pack for #8/);
  const noIdea = await refusal('/api/prs/7/review-pack/ideas/idea_gone/read', { read: true });
  assert.equal(noIdea.status, 404);
  assert.match(noIdea.error, /no idea idea_gone in the current pack/);
  const noHunk = await refusal(`/api/prs/7/review-pack/ideas/${contextOnly!.id}/read`, { read: true });
  assert.equal(noHunk.status, 409);
  assert.match(noHunk.error, /owns no changed code/);
  assert.equal(system.store.listReviewMarks(7).length, 0, 'nothing was written');
  await app.close();
  system.store.close();
});

test('a mark survives the pack being rewritten and lands on whichever idea owns the hunk now', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD });
  await system.harness.runCycle('manual');
  const first = await authored(system);
  const { app } = await buildApp(system);
  const read = await app.inject({
    method: 'POST',
    url: `/api/prs/7/review-pack/ideas/${first.pack.ideas[0]!.id}/read`,
    payload: { read: true },
  });
  assert.equal(read.statusCode, 200, read.body);

  // Let the author finish — the checker follows — and take the checker off the
  // pull request so a second ask is not refused as "being checked".
  system.agents.complete(first.author.id);
  await system.reviewPackChecker.whenIdle();
  const checker = agentOn(system, checkOrigin(7));
  assert.ok(checker, 'the checker followed the author');
  system.agents.kill(checker!.id);

  const second = await authored(system, { first: 'The same import, retold' });
  const rewritten = second.pack.ideas[0]!;
  assert.notEqual(rewritten.id, first.pack.ideas[0]!.id, 'the idea id was minted afresh');

  const got = await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' });
  const payload = got.json() as ReviewPackPayload;
  assert.equal(payload.pack.ideas[0]!.title, 'The same import, retold');
  assert.equal(payload.marks.length, 1, 'the mark is still there, keyed to the hunk');
  assert.deepEqual(layMarks(payload.pack, payload.marks).get(rewritten.id), { read: true, attention: null });
  await app.close();
  system.store.close();
});
