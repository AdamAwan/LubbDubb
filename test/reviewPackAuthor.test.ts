import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { packLeaseHead, packLeaseKey, packOrigin, packTargetPr } from '../src/reviewPacks/author.js';
import { coverageRefusal, parseDiffHunks } from '../src/reviewPacks/hunks.js';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import type { Agent, ReviewPack } from '../src/types.js';
import type { ReviewPackPayload } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { findTask } from './support/tasks.js';

/**
 * Review packs, stage 3: the author agent and the async route — a reviewer asks
 * for a pack from the pull request's row, an agent is spawned outside the
 * dispatcher over the diff, both pads and the tree, and hands the pack back
 * through `review_pack_submit`, which refuses one that leaves a hunk unowned.
 * → docs/spec/31-review-packs.md#when-a-pack-is-made
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD2 = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';

/** Two files, one with two hunks; a pure deletion; a deleted file; a binary. */
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
  '@@ -20,2 +21,3 @@ export function f() {',
  '   return a;',
  '+  // noted',
  ' }',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 3333333..4444444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,2 +9,0 @@ const gone = 1;',
  '-const old = 2;',
  '-const older = 3;',
  'diff --git a/src/c.ts b/src/c.ts',
  'deleted file mode 100644',
  'index 5555555..0000000',
  '--- a/src/c.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const c = 1;',
  '-export const d = 2;',
  'diff --git a/img.png b/img.png',
  'index 6666666..7777777 100644',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n');

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): { system: System; worktrees: FakeWorktreeManager; git: FakeGitObserver; reaps: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pack-'));
  const worktrees = new FakeWorktreeManager();
  const git = new FakeGitObserver().setDiff('main', HEAD, DIFF);
  const reaps: number[] = [];
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
    }),
    {
      worktrees,
      gitObserver: git,
      backend: new FakePtyBackend(),
      errorMirror: () => {},
      reapProcessTree: async (pid) => {
        reaps.push(pid);
      },
    },
  );
  return { system, worktrees, git, reaps };
}

/** A pull request with a head, in the world the routes read. */
async function openPr(system: System, over: { headSha?: string } = { headSha: HEAD }): Promise<void> {
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', ...over });
  await system.harness.runCycle('manual');
}

async function ask(system: System): Promise<{ agent: Agent; cwd: string }> {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202, res.body);
  await app.close();
  await system.reviewPacks.whenIdle();
  const task = findTask(system.store, (t) => t.originRef === packOrigin(7));
  assert.ok(task, 'the author task exists');
  const agent = system.store.listAgents().find((a) => a.taskId === task!.id);
  assert.ok(agent, 'the author agent was spawned');
  return { agent: agent!, cwd: agent!.cwd };
}

async function submit(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('review_pack_submit', args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/** Every hunk owned once: h1 and h2 by the idea, h3 and h4 by plumbing. */
function fullSubmission(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headline: 'The module imports y and notes why.',
    summary: 'Two files change; **the import is the point**, the rest is tidy-up.',
    estimatedMinutes: 4,
    ideas: [
      {
        claim: 'a.ts gains a dependency on y and nothing else reads it.',
        title: 'One new import, and only one file needs it',
        anchors: [
          { kind: 'hunk', hunk: 'h1', gist: 'The import lands here.', mark: 'key', caption: 'new import' },
          { kind: 'hunk', hunk: 'h2', gist: 'The comment says why.' },
          {
            kind: 'region',
            path: 'src/unchanged.ts',
            start: 2,
            end: 3,
            gist: 'Should this have changed? No — it never read x either.',
            note: { by: 'author', text: 'Checked every importer.' },
          },
        ],
        claims: [{ text: 'src/unchanged.ts does not import y.', provenance: { kind: 'inferred' } }],
      },
      {
        id: 'plumbing',
        claim: 'The deletions carry nothing to review.',
        title: 'Dead code goes',
        anchors: [
          { kind: 'hunk', hunk: 'h3', gist: 'Two unused constants.' },
          { kind: 'hunk', hunk: 'h4', gist: 'A file nothing imported.' },
        ],
        claims: [],
      },
    ],
    ...extra,
  };
}

// -- the hunks, purely --------------------------------------------------------

test('a diff parses into hunks with head-side ranges, and a pure deletion carries a zero-width range', () => {
  const hunks = parseDiffHunks(DIFF);
  assert.deepEqual(
    hunks.map((h) => [h.id, h.range.path, h.range.start, h.range.end, h.added, h.removed]),
    [
      ['h1', 'src/a.ts', 1, 4, 1, 0],
      ['h2', 'src/a.ts', 21, 23, 1, 0],
      // `+9,0`: the deletion sits after line 9 at the head, and nothing there is its code.
      ['h3', 'src/b.ts', 9, 9, 0, 2],
      // A deleted file keeps its old path; `+0,0` clamps to line 1.
      ['h4', 'src/c.ts', 1, 1, 0, 2],
    ],
  );
  // The code keeps its diff prefixes, context lines included.
  assert.deepEqual(hunks[0]!.code, [' import x from "x";', '+import y from "y";', ' ', ' export const a = 1;']);
  assert.deepEqual(hunks[2]!.code, ['-const old = 2;', '-const older = 3;']);
  // A binary file produced no hunk: there is nothing for an idea to own.
  assert.equal(
    hunks.some((h) => h.range.path === 'img.png'),
    false,
  );
  assert.deepEqual(parseDiffHunks(''), []);
});

test('coverage is decided mechanically: every hunk owned exactly once, plumbing included', () => {
  const hunks = parseDiffHunks(DIFF);
  assert.equal(
    coverageRefusal(
      hunks,
      new Map([
        ['idea_1', ['h1', 'h2']],
        ['plumbing', ['h3', 'h4']],
      ]),
    ),
    null,
  );
  assert.match(
    coverageRefusal(hunks, new Map([['idea_1', ['h1', 'h2', 'h3']]])) ?? '',
    /these have none: h4 \(src\/c\.ts:1-1\)/,
  );
  assert.match(
    coverageRefusal(
      hunks,
      new Map([
        ['idea_1', ['h1', 'h2', 'h3', 'h4']],
        ['plumbing', ['h3']],
      ]),
    ) ?? '',
    /h3 \(owned by idea_1 and plumbing\)/,
  );
  assert.match(coverageRefusal(hunks, new Map([['idea_1', ['h1', 'h2', 'h3', 'h4', 'h9']]])) ?? '', /no such hunk: h9/);
});

test("the author's origin and lease key name the pull request and the head, and nothing else parses as them", () => {
  assert.equal(packOrigin(7), 'pr:7:pack');
  assert.equal(packTargetPr('pr:7:pack'), 7);
  assert.equal(packTargetPr('pr:7:review'), null);
  assert.equal(packLeaseHead(packLeaseKey(7, HEAD)), HEAD);
  assert.equal(packLeaseHead('review/pr-7'), null);
  assert.equal(packLeaseHead(null), null);
});

// -- asking, at the seam --------------------------------------------------------

test('asking for a pack spawns a read-only author outside the pulse, and the ask returns before it runs', async () => {
  const { system, worktrees } = build();
  await openPr(system);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { ok: true, prNumber: 7, headSha: HEAD });
  // Accepted, not done: nothing has been written and the read says one is coming.
  const early = await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' });
  assert.equal(early.statusCode, 404);
  assert.equal(early.json().writing, true);
  // A second ask while the first is on its way is refused, not queued.
  const again = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /already being written/);

  await system.reviewPacks.whenIdle();
  const task = findTask(system.store, (t) => t.originRef === packOrigin(7));
  assert.ok(task);
  assert.equal(task!.kind, 'code');
  assert.equal(task!.rule, null, 'no rule dispatched this');
  assert.equal(task!.branch, packLeaseKey(7, HEAD));
  // The worktree came through the read-only shape of the one seam, pinned at the head.
  assert.deepEqual(worktrees.ensured, [{ branch: packLeaseKey(7, HEAD), base: HEAD, readOnly: true }]);
  // No decision row: this was never a dispatch.
  assert.equal(
    system.store.listDecisions().some((d) => d.detail.includes('pr:7:pack')),
    false,
  );

  // What the agent was handed: the rendered template, then the hunks by id, the
  // absent log, and the submission note — appended, in that order.
  const prompt = task!.prompt;
  assert.match(
    prompt,
    /Write the review pack for PR #7 \("Add y"\) — branch feature-7, targeting main, at head a1b2c3d4/,
  );
  assert.match(prompt, /- h1: src\/a\.ts:1-4 \(\+1 −0\)/);
  assert.match(prompt, /- h3: src\/b\.ts:9-9 \(\+0 −2\)/);
  assert.match(prompt, /Nobody witnessed this pull request/);
  assert.match(prompt, /links PR #7 to no goal/);
  assert.match(prompt, /review_pack_submit/);
  assert.ok(prompt.indexOf('## The hunks') < prompt.indexOf('## The witness log'));
  assert.ok(prompt.indexOf('## The witness log') < prompt.indexOf('## Handing the pack back'));

  await app.close();
  system.store.close();
});

test('the ask refuses in order: no such pull request, no head, paused', async () => {
  const { system } = build();
  const { app } = await buildApp(system);
  const missing = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(missing.statusCode, 404);
  const bad = await app.inject({ method: 'POST', url: '/api/prs/abc/review-pack' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { error: 'invalid PR number' });

  await openPr(system, {});
  const headless = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(headless.statusCode, 409);
  assert.match(headless.json().error, /reports no head/);

  system.connector.inject({ kind: 'pr_pushed', prNumber: 7, headSha: HEAD });
  await system.harness.runCycle('manual');
  system.runtimeControl.apply({ paused: true });
  const paused = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(paused.statusCode, 409);
  assert.match(paused.json().error, /paused/);
  assert.equal(
    findTask(system.store, (t) => t.originRef === packOrigin(7)),
    undefined,
  );

  // Nothing was asked for, so the read says so rather than "on its way".
  const none = await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' });
  assert.equal(none.statusCode, 404);
  assert.equal(none.json().writing, false);
  await app.close();
  system.store.close();
});

test('a head the clone cannot diff fails the ask loudly and leaves no lease behind', async () => {
  const { system, worktrees } = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD2 });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202, 'the ask is accepted; the failure is downstream');
  await system.reviewPacks.whenIdle();
  assert.equal(
    findTask(system.store, (t) => t.originRef === packOrigin(7)),
    undefined,
  );
  assert.deepEqual(worktrees.ensured, []);
  assert.ok(system.store.listErrors().some((e) => /Could not start the review pack author for PR #7/.test(e.message)));
  // ...and the pull request can be asked about again.
  assert.equal(system.reviewPacks.writing(7), false);
  await app.close();
  system.store.close();
});

// -- the submission ---------------------------------------------------------------

test('the author submits a pack and the harness fills in what it owns; the read ships it with its marks', async () => {
  const { system, worktrees, reaps } = build();
  await openPr(system);
  const { agent, cwd } = await ask(system);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/unchanged.ts'), 'line one\nline two\nline three\nline four\n');

  const written: number[] = [];
  system.reviewPacks.on('written', ({ record }) => written.push(record.pack.prNumber));
  const res = await submit(system, agent, fullSubmission());
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(written, [7]);

  const record = system.store.getCurrentReviewPack(7);
  assert.ok(record);
  const pack: ReviewPack = record!.pack;
  assert.equal(pack.schema, REVIEW_PACK_SCHEMA);
  assert.equal(pack.prNumber, 7);
  assert.equal(pack.headSha, HEAD);
  assert.equal(pack.witnessed, false, 'neither pad had an entry');
  assert.equal(pack.fake, 'nothing');
  assert.deepEqual(pack.order, []);
  // Ids are minted, but the reserved one is kept.
  assert.match(pack.ideas[0]!.id, /^idea_/);
  assert.equal(pack.ideas[1]!.id, 'plumbing');
  // Every checker field is null, whatever the author might have said.
  for (const idea of pack.ideas) {
    assert.equal(idea.attention, null);
    assert.equal(idea.cue, null);
    for (const claim of idea.claims) {
      assert.equal(claim.verdict, null);
      assert.equal(claim.evidence, null);
    }
  }
  // The hunk anchors carry the diff's own ranges and code — what a mark is keyed on.
  const [h1, h2, region] = pack.ideas[0]!.anchors;
  assert.deepEqual(h1!.range, { path: 'src/a.ts', start: 1, end: 4 });
  assert.deepEqual(h1!.code, [' import x from "x";', '+import y from "y";', ' ', ' export const a = 1;']);
  assert.equal(h1!.mark, 'key');
  assert.equal(h1!.caption, 'new import');
  assert.deepEqual(h2!.range, { path: 'src/a.ts', start: 21, end: 23 });
  // The region's code was read off the tree at the head, plain.
  assert.equal(region!.kind, 'region');
  assert.deepEqual(region!.code, ['line two', 'line three']);
  assert.deepEqual(region!.note, { by: 'author', text: 'Checked every importer.' });
  assert.deepEqual(pack.ideas[1]!.anchors[0]!.range, { path: 'src/b.ts', start: 9, end: 9 });

  // The read: the record, the marks, the head, and not stale.
  const { app } = await buildApp(system);
  system.store.markReviewIdeaRead({ prNumber: 7, headSha: HEAD, hunks: [h1!.range], read: true });
  const got = await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' });
  assert.equal(got.statusCode, 200);
  const payload = got.json() as ReviewPackPayload;
  assert.deepEqual(payload.pack, pack);
  assert.equal(payload.writtenAt, record!.writtenAt);
  assert.equal(payload.marks.length, 1);
  assert.equal(payload.head, HEAD);
  assert.equal(payload.stale, null);
  await app.close();

  // The author is an agent like any other: the operator's kill reaps its subtree
  // through session.kill(), and the reap hands its slot back.
  const pid = system.store.getAgent(agent.id)?.pid;
  system.agents.kill(agent.id);
  assert.equal(system.store.getAgent(agent.id)?.status, 'killed');
  assert.deepEqual(reaps, [pid], 'the subtree is reaped through session.kill()');
  assert.deepEqual(worktrees.removed, [packLeaseKey(7, HEAD)]);
  system.store.close();
});

test('a pack is refused by field name — an unowned hunk, one owned twice, a mark that is not the author’s, a claim citing no entry', async () => {
  const { system } = build();
  await openPr(system);
  const { agent, cwd } = await ask(system);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/unchanged.ts'), 'line one\nline two\nline three\n');

  const base = fullSubmission();
  const ideas = base.ideas as Record<string, unknown>[];

  const unowned = await submit(system, agent, {
    ...base,
    ideas: [ideas[0], { ...ideas[1], anchors: [(ideas[1]!.anchors as unknown[])[0]] }],
  });
  assert.equal(unowned.isError, true);
  assert.match(unowned.text, /these have none: h4 \(src\/c\.ts:1-1\)/);

  const twice = await submit(system, agent, {
    ...base,
    ideas: [
      { ...ideas[0], anchors: [...(ideas[0]!.anchors as unknown[]), { kind: 'hunk', hunk: 'h3', gist: 'again' }] },
      ideas[1],
    ],
  });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /h3 \(owned by idea_\w+ and plumbing\)/);

  const falseMark = await submit(system, agent, {
    ...base,
    ideas: [{ ...ideas[0], anchors: [{ kind: 'hunk', hunk: 'h1', gist: 'x', mark: 'false' }] }, ideas[1]],
  });
  assert.equal(falseMark.isError, true);
  assert.match(falseMark.text, /ideas\[0\]\.anchors\[0\]\.mark must be "key" or "disputed"/);

  const uncited = await submit(system, agent, {
    ...base,
    ideas: [
      { ...ideas[0], claims: [{ text: 'x', provenance: { kind: 'witnessed', entryId: 'scr_nothing' } }] },
      ideas[1],
    ],
  });
  assert.equal(uncited.isError, true);
  assert.match(uncited.text, /ideas\[0\]\.claims\[0\]\.provenance\.entryId must cite/);

  const outside = await submit(system, agent, {
    ...base,
    ideas: [
      {
        ...ideas[0],
        anchors: [
          ...(ideas[0]!.anchors as unknown[]).slice(0, 2),
          { kind: 'region', path: '../etc/passwd', start: 1, end: 1, gist: 'no' },
        ],
      },
      ideas[1],
    ],
  });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /is not in the tree at the head/);

  const minted = await submit(system, agent, { ...base, ideas: [{ ...ideas[0], id: 'idea_mine' }, ideas[1]] });
  assert.equal(minted.isError, true);
  assert.match(minted.text, /ids are minted by the harness/);

  assert.equal(system.store.getCurrentReviewPack(7), null, 'nothing landed');
  // The fixed submission lands in the same turn.
  const fixed = await submit(system, agent, base);
  assert.equal(fixed.isError, false, fixed.text);
  system.store.close();
});

test('the pack is written from both pads: a witnessed claim cites an entry, and the note is stamped from it', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Import y' });
  await openPr(system);
  system.connector.inject({ kind: 'issue_linked_pr', number: 12, prNumber: 7 });
  await system.harness.runCycle('manual');
  const goalEntry = system.store.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:import',
    agentId: 'a1',
    taskId: 't1',
    topic: null,
    note: 'Imported y rather than inlining it.',
    decision: {
      chose: 'Import y',
      because: 'it is already a dependency',
      rejected: [{ alternative: 'Inline it', because: 'two copies drift' }],
      paths: ['src/a.ts'],
    },
  });
  const prEntry = system.store.appendScratchEntry({
    padRef: 'pr:7',
    authorOriginRef: 'pr:7:ci',
    agentId: 'a2',
    taskId: 't2',
    topic: 'ci',
    note: 'Removed the two constants the linter flagged.',
    decision: null,
  });
  const { agent, cwd } = await ask(system);
  const task = findTask(system.store, (t) => t.originRef === packOrigin(7))!;
  // Both pads, verbatim, with their ids — the ids are what a claim cites.
  assert.match(task.prompt, /the pad of the goal \(issue:12\) and the pull request's own \(pr:7\)/);
  assert.ok(task.prompt.includes(`- ${goalEntry.id} · `));
  assert.ok(task.prompt.includes('  rejected: Inline it — two copies drift'));
  assert.ok(task.prompt.includes(`- ${prEntry.id} · `));

  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/unchanged.ts'), 'line one\nline two\nline three\n');
  const base = fullSubmission();
  const ideas = base.ideas as Record<string, unknown>[];
  const res = await submit(system, agent, {
    ...base,
    ideas: [
      {
        ...ideas[0],
        anchors: [
          {
            kind: 'hunk',
            hunk: 'h1',
            gist: 'x',
            note: { by: 'witness', entryId: goalEntry.id, text: 'Imported y rather than inlining it.' },
          },
          { kind: 'hunk', hunk: 'h2', gist: 'y' },
        ],
        claims: [
          { text: 'y is already a dependency.', provenance: { kind: 'witnessed', entryId: goalEntry.id } },
          {
            text: 'The linter flagged three constants, not two.',
            provenance: { kind: 'disputed', entryId: prEntry.id },
          },
        ],
      },
      ideas[1],
    ],
  });
  assert.equal(res.isError, false, res.text);
  const pack = system.store.getCurrentReviewPack(7)!.pack;
  assert.equal(pack.witnessed, true);
  assert.deepEqual(pack.ideas[0]!.anchors[0]!.note, {
    by: 'witness',
    entryId: goalEntry.id,
    text: 'Imported y rather than inlining it.',
    at: goalEntry.createdAt,
  });
  assert.deepEqual(
    pack.ideas[0]!.claims.map((c) => c.provenance),
    [
      { kind: 'witnessed', entryId: goalEntry.id },
      { kind: 'disputed', entryId: prEntry.id },
    ],
  );
  system.store.close();
});

test('the tool is refused to any agent that is not an author, by name', async () => {
  const { system } = build();
  const task = system.store.createTask({
    kind: 'code',
    title: 'Review',
    prompt: 'read',
    branch: 'review/pr-7',
    originRef: 'pr:7:review',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
  const res = await submit(system, agent, fullSubmission());
  assert.equal(res.isError, true);
  assert.match(res.text, /dispatched for pr:7:review\. Nothing was recorded/);
  system.store.close();
});

// -- staleness ----------------------------------------------------------------------

test('a pack is shown stale when the head moves, saying how far behind, and nothing regenerates it', async () => {
  const { system, git } = build();
  await openPr(system);
  const { agent, cwd } = await ask(system);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/unchanged.ts'), 'line one\nline two\nline three\n');
  assert.equal((await submit(system, agent, fullSubmission())).isError, false);

  system.connector.inject({ kind: 'pr_pushed', prNumber: 7, headSha: HEAD2 });
  git.setDivergence(HEAD2, HEAD, { ahead: 2, behind: 0 });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const got = await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' });
  assert.equal(got.statusCode, 200);
  const payload = got.json() as ReviewPackPayload;
  assert.equal(payload.pack.headSha, HEAD, 'the pack is still the one written');
  assert.equal(payload.head, HEAD2);
  assert.deepEqual(payload.stale, { headSha: HEAD2, commitsBehind: 2 });
  // The pulse dispatched nothing for it, and neither did the read.
  const authors = system.store.listTasks().filter((t) => t.originRef === packOrigin(7));
  assert.equal(authors.length, 1);

  // A head the clone has not seen: stale by sha, and the count says it cannot say.
  system.connector.inject({ kind: 'pr_pushed', prNumber: 7, headSha: 'c3d4e5f60718293a4b5c6d7e8f901234567890ab' });
  await system.harness.runCycle('manual');
  const unknown = (await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' })).json() as ReviewPackPayload;
  assert.deepEqual(unknown.stale, { headSha: 'c3d4e5f60718293a4b5c6d7e8f901234567890ab', commitsBehind: null });

  // Asking again on the new head is the same control; the new pack replaces the
  // old. Refused while the first author is still on the pull request, accepted
  // once it has finished.
  git.setDiff('main', 'c3d4e5f60718293a4b5c6d7e8f901234567890ab', DIFF);
  const busy = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(busy.statusCode, 409);
  system.agents.complete(agent.id);
  const again = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(again.statusCode, 202);
  await system.reviewPacks.whenIdle();
  assert.equal(system.store.listTasks().filter((t) => t.originRef === packOrigin(7)).length, 2);
  await app.close();
  system.store.close();
});

// -- structure ------------------------------------------------------------------------

test('nothing under src/dispatcher/ imports the review pack author — it is not a dispatch input', () => {
  const root = resolve(import.meta.dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [],
    );
  const offenders = walk('src/dispatcher').filter((f) => /reviewPacks\//.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(offenders, [], 'a pack is a read-only view assembled after the work');
});
