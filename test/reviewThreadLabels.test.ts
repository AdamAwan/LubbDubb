import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type ReviewAreaRule } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { areasForPath } from '../src/reviewLabels/areas.js';
import { buildReviewLabelInsights } from '../src/insights/reviewLabelInsights.js';
import type { Agent, PrThreadLabel, WorldSnapshot } from '../src/types.js';

const AREAS: ReviewAreaRule[] = [
  { area: 'ui', path: '^web/src/' },
  { area: 'sql', path: '^src/store/' },
  { area: 'backend', path: '^src/(?!store/)' },
  { area: 'test', path: '\\.test\\.tsx?$' },
];

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-labels-'));
  const config = loadConfig({
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function worldWithThread(opts: { path?: string; author?: string }): WorldSnapshot {
  return {
    takenAt: new Date().toISOString(),
    issues: [],
    pullRequests: [
      {
        id: 'pr-42',
        number: 42,
        title: 'A pull request',
        branch: 'feature/x',
        ciStatus: 'passing',
        unresolvedComments: [],
        reviewThreads: [
          {
            id: 'c-1',
            author: opts.author ?? 'a-reviewer',
            body: 'This comment is stale.',
            state: 'open',
            replies: [],
            ...(opts.path === undefined ? {} : { path: opts.path }),
          },
        ],
      },
    ],
  };
}

function reviewAgent(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Address review comments on PR #42',
    prompt: 'answer them',
    branch: 'feature/x',
    originRef: 'pr:42:comments',
    originTitle: 'A pull request',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callReply(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('reply_to_review', args)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('answering a thread records what it was about, with the path the world holds for it', async () => {
  const system = build();
  system.store.world.setWorldBaseline(worldWithThread({ path: 'web/src/components/Panel.tsx' }));
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, {
    body: 'Dropped the comment — the spec owns that explanation.',
    thread: 'c-1',
    about_comment: true,
    changed_code: true,
    resolved: true,
  });
  assert.equal(res.isError, false);

  const [label] = system.store.prThreadLabels.listThreadLabelsSince('');
  assert.equal(label!.prNumber, 42);
  assert.equal(label!.threadId, 'c-1');
  assert.equal(label!.aboutComment, true);
  assert.equal(label!.changedCode, true);
  assert.equal(label!.resolved, true);
  assert.equal(label!.path, 'web/src/components/Panel.tsx', 'the path comes from the world, not the agent');
  assert.equal(label!.author, 'a-reviewer');
  system.store.close();
});

test('coming back to a thread replaces its label rather than counting it twice', async () => {
  const system = build();
  system.store.world.setWorldBaseline(worldWithThread({ path: 'src/store/tasks.ts' }));
  const agent = reviewAgent(system);

  await callReply(system, agent, { body: 'Defending this.', thread: 'c-1', about_comment: true, changed_code: false });
  await callReply(system, agent, {
    body: 'You were right, changed it.',
    thread: 'c-1',
    about_comment: false,
    changed_code: true,
  });

  const labels = system.store.prThreadLabels.listThreadLabelsSince('');
  assert.equal(labels.length, 1, 'one row per thread, however often the fleet came back');
  assert.equal(labels[0]!.aboutComment, false, 'the last answer wins');
  assert.equal(labels[0]!.changedCode, true);
  system.store.close();
});

test('a reply to the pull request itself is anchored to no thread, so it is labelled nowhere', async () => {
  const system = build();
  system.store.world.setWorldBaseline(worldWithThread({ path: 'src/system.ts' }));
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, {
    body: 'Rebased onto main.',
    about_comment: false,
    changed_code: true,
  });
  assert.equal(res.isError, false);
  assert.equal(system.store.prThreadLabels.listThreadLabelsSince('').length, 0);
  system.store.close();
});

test('a thread the world holds no path for is recorded unanchored rather than guessed at', async () => {
  const system = build();
  system.store.world.setWorldBaseline(worldWithThread({}));
  const agent = reviewAgent(system);

  await callReply(system, agent, { body: 'Answered.', thread: 'c-1', about_comment: false, changed_code: false });

  const [label] = system.store.prThreadLabels.listThreadLabelsSince('');
  assert.equal(label!.path, null);
  assert.equal(areasForPath(label!.path, AREAS), null, 'null is not an area, and not the residual one either');
  system.store.close();
});

test('a path belongs to every area whose rule matches it, and to none where nothing does', () => {
  assert.deepEqual(areasForPath('web/src/components/Panel.tsx', AREAS), ['ui']);
  assert.deepEqual(areasForPath('src/store/tasks.ts', AREAS), ['sql']);
  assert.deepEqual(areasForPath('src/system.ts', AREAS), ['backend']);
  assert.deepEqual(areasForPath('web/src/cockpit/place.test.tsx', AREAS), ['ui', 'test'], 'overlap is kept');
  assert.deepEqual(areasForPath('README.md', AREAS), [], 'matched by nothing, but still anchored');
  assert.equal(areasForPath(null, AREAS), null);
});

test('a rule that is not a regular expression is skipped rather than throwing', () => {
  assert.deepEqual(
    areasForPath('src/system.ts', [
      { area: 'broken', path: '([' },
      { area: 'ok', path: '^src/' },
    ]),
    ['ok'],
  );
});

function label(over: Partial<PrThreadLabel> = {}): PrThreadLabel {
  return {
    prNumber: 42,
    threadId: 't',
    aboutComment: false,
    changedCode: true,
    resolved: true,
    path: 'src/system.ts',
    author: 'a-reviewer',
    agentId: 'a',
    taskId: 't',
    answeredAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('the reading counts a thread once per area it is in, and says what it could not place', () => {
  const insights = buildReviewLabelInsights({
    labels: [
      label({ threadId: 't1', path: 'web/src/a.tsx', aboutComment: true }),
      label({ threadId: 't2', path: 'web/src/a.test.tsx' }),
      label({ threadId: 't3', path: 'README.md' }),
      label({ threadId: 't4', path: null }),
    ],
    replies: [
      { prNumber: 42, threadId: 't1', commentRef: 'r1', sentAt: '2026-01-01T00:00:00.000Z' },
      { prNumber: 42, threadId: 't1', commentRef: 'r2', sentAt: '2026-01-01T00:01:00.000Z' },
      { prNumber: 42, threadId: 't2', commentRef: 'r3', sentAt: '2026-01-01T00:02:00.000Z' },
      { prNumber: 99, threadId: 'other', commentRef: 'r4', sentAt: '2026-01-01T00:03:00.000Z' },
    ],
    areas: AREAS,
  });

  assert.equal(insights.threads, 4);
  assert.equal(insights.aboutComment, 1);
  assert.equal(insights.unanchored, 1, 'the thread on no file');
  assert.equal(insights.unplaced, 1, 'the thread on a file no rule claims');
  assert.equal(insights.byArea.find((a) => a.area === 'ui')!.threads, 2);
  assert.equal(insights.byArea.find((a) => a.area === 'test')!.threads, 1);
  assert.equal(insights.byArea.find((a) => a.area === 'sql')!.threads, 0, 'a declared area with nothing in it stays');
  assert.equal(insights.replies, 3, 'the reply on a thread this window never labelled is not counted');
  assert.equal(insights.answeredOnce, 1, 't2 alone was answered once and left alone');
});
