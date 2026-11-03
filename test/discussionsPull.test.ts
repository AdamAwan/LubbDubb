import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { DiscussionFiles } from '../src/discussions/discussionFile.js';
import { DiscussionPullDesk } from '../src/discussions/pullDesk.js';
import type { ErrorLogInput, TrackerComment, WorldSnapshot } from '../src/types.js';

function harness(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discuss-pull-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: 'lubbdubb',
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot: dir,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      discussionsDir: join(dir, 'vault'),
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  system.connector.inject({ kind: 'new_issue', number: 11, title: 'Export to CSV' });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Import' });
  return system;
}

function open(system: System, number: number): void {
  const write = system.discussions.add(
    { number, title: `Issue ${number}`, kind: 'story' },
    { kind: 'note', body: 'opened', author: 'operator' },
  );
  assert.ok(write.ok);
}

function notes(system: System, number: number): { author: string | null; body: string }[] {
  return (system.discussions.read(number)?.entries ?? [])
    .filter((e) => e.kind === 'note')
    .map((e) => ({ author: e.author, body: e.body }));
}

test('the cycle pulls a person’s comments in as notes, and skips the harness’s own by record — never by author', async () => {
  const system = harness();
  open(system, 11);
  await system.sink.upsertIssueComment({ number: 11, body: 'LubbDubb status', commentRef: null });
  // The fake posts the harness's comments as "operator" — the operator's own login on a single-operator deployment.
  system.connector.inject({ kind: 'issue_comment', number: 11, author: 'operator', body: 'My own follow-up.' });
  system.connector.inject({ kind: 'issue_comment', number: 11, author: 'sam', body: 'What about XLSX?' });

  await system.harness.runCycle('manual');

  assert.deepEqual(notes(system, 11), [
    { author: 'operator', body: 'opened' },
    { author: '@operator (tracker)', body: 'My own follow-up.' },
    { author: '@sam (tracker)', body: 'What about XLSX?' },
  ]);
  const doc = system.discussions.read(11);
  assert.ok(doc?.frontMatter.pulled, 'the newest comment pulled is the watermark');

  const again = await system.discussionPulls.pull(11);
  assert.deepEqual(again.ok && again.added, 0, 'a comment already pulled is never pulled twice');
  system.store.close();
});

test('only an issue that already has a file is pulled', async () => {
  const system = harness();
  system.connector.inject({ kind: 'issue_comment', number: 12, author: 'sam', body: 'Hello' });
  await system.harness.runCycle('manual');
  assert.equal(system.discussions.read(12), null, 'no file is created by a pull');
  system.store.close();
});

test('the published comment is skipped by its id in the front matter', async () => {
  const system = harness();
  open(system, 11);
  const sent = await system.connector.upsertIssueComment({ number: 11, body: 'Summary', commentRef: null });
  assert.ok(sent.ref);
  assert.ok(system.discussions.setFrontMatter(11, { published: sent.ref }).ok);
  const pulled = await system.discussionPulls.pull(11);
  assert.ok(pulled.ok);
  assert.equal(pulled.added, 0);
  assert.equal(pulled.skipped, 1);
  system.store.close();
});

function errors(): { recorded: ErrorLogInput[]; record: (input: ErrorLogInput) => never } {
  const recorded: ErrorLogInput[] = [];
  return { recorded, record: (input) => recorded.push(input) as never };
}

const WORLD: WorldSnapshot = {
  takenAt: '2026-11-03T12:00:00.000Z',
  pullRequests: [],
  issues: [{ id: 'i11', number: 11, title: 'x', body: '', labels: [], state: 'open', linkedPrNumber: null }],
};

function desk(comments: () => Promise<TrackerComment[]>, now: { ms: number }) {
  const log = errors();
  const files = new DiscussionFiles({
    dir: mkdtempSync(join(tmpdir(), 'lubbdubb-discuss-desk-')),
    repo: 'r',
    errors: log,
  });
  assert.ok(
    files.add({ number: 11, title: 'x', kind: 'story' }, { kind: 'note', body: 'opened', author: 'operator' }).ok,
  );
  const calls: (string | null)[] = [];
  const pulls = new DiscussionPullDesk({
    discussions: files,
    comments: {
      canListIssueComments: () => true,
      listIssueComments: (_n, since) => {
        calls.push(since);
        return comments();
      },
    },
    sent: () => new Set(),
    errors: log,
    nowMs: () => now.ms,
  });
  return { pulls, files, calls, log };
}

test('the cycle pulls an issue at most every few minutes; discussion_pull is not held to that', async () => {
  const now = { ms: 0 };
  const d = desk(async () => [], now);
  await d.pulls.run(WORLD);
  await d.pulls.run(WORLD);
  assert.equal(d.calls.length, 1, 'a second pulse straight after reads nothing');
  await d.pulls.pull(11);
  assert.equal(d.calls.length, 2);
  now.ms += 10 * 60_000;
  await d.pulls.run(WORLD);
  assert.equal(d.calls.length, 3);
});

test('a tracker that cannot answer is recorded and leaves the watermark where it was', async () => {
  const d = desk(
    async () => {
      throw new Error('rate limited');
    },
    { ms: 0 },
  );
  const result = await d.pulls.pull(11);
  assert.equal(result.ok, false);
  assert.equal(d.log.recorded.length, 1);
  assert.match(d.log.recorded[0]!.detail ?? '', /rate limited/);
  assert.equal(d.files.read(11)?.frontMatter.pulled, null);
});

test('the watermark is handed back to the provider, so only newer comments are asked for', async () => {
  const d = desk(async () => [{ id: '1', author: 'sam', body: 'hi', createdAt: '2026-11-03T14:02:11Z' }], { ms: 0 });
  await d.pulls.pull(11);
  assert.equal(d.files.read(11)?.frontMatter.pulled, '2026-11-03T14:02:11Z');
  assert.ok(d.files.read(11)?.entries.some((e) => e.author === '@sam (tracker)' && e.body === 'hi'));
  await d.pulls.pull(11);
  assert.deepEqual(d.calls, [null, '2026-11-03T14:02:11Z']);
});
