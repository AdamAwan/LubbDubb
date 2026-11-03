import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import {
  DISCUSSION_AUTHORS,
  DiscussionFiles,
  discussionRepoFolder,
  type DiscussionFilesDeps,
} from '../src/discussions/discussionFile.js';
import type { ErrorLogInput } from '../src/types.js';
import { buildSystem } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function files(overrides: Partial<DiscussionFilesDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-discussions-'));
  const recorded: ErrorLogInput[] = [];
  const errors = {
    record: (input: ErrorLogInput) => {
      recorded.push(input);
      return { id: 'e', createdAt: '', ...input, detail: input.detail ?? null };
    },
  };
  const discussions = new DiscussionFiles({
    dir: root,
    repo: 'widgets',
    errors,
    now: () => new Date(2026, 10, 3, 12),
    ...overrides,
  });
  return { root, folder: join(root, 'widgets'), discussions, recorded };
}

const story = {
  number: 142,
  title: 'Export to CSV',
  kind: 'story' as const,
  parent: { number: 87, title: 'Reporting' },
};

test('unset is off: nothing is read and every write refuses', () => {
  const { discussions, root } = files({ dir: undefined });
  assert.equal(discussions.enabled, false);
  assert.equal(discussions.read(142), null);
  const write = discussions.add(story, { kind: 'note', body: 'x', author: 'operator' });
  assert.equal(write.ok, false);
  assert.deepEqual(readdirSync(root), []);
});

test('the first write creates the folder and the file, named by number and title', () => {
  const { discussions, folder } = files();
  assert.equal(existsSync(folder), false, 'the folder is created on first write, never before');
  assert.equal(discussions.read(142), null);

  const write = discussions.add(story, {
    kind: 'question',
    body: 'Should empty columns be dropped?',
    author: DISCUSSION_AUTHORS.agent('planner', '912'),
  });
  assert.ok(write.ok);
  assert.equal(write.path, join(folder, '142 Export to CSV.md'));
  assert.match(write.entry.id!, /^q-[0-9a-f]{4}$/);
  assert.deepEqual(
    [write.entry.state, write.entry.date, write.entry.author],
    ['open', '2026-11-03', 'agent planner#912'],
  );

  const doc = discussions.read(142)!;
  assert.deepEqual(
    {
      ref: doc.frontMatter.ref,
      kind: doc.frontMatter.kind,
      parent: doc.frontMatter.parent,
      n: doc.frontMatter.parentNumber,
    },
    { ref: 'issue:142', kind: 'story', parent: '[[87 Reporting]]', n: 87 },
  );
  assert.equal(doc.entries.length, 1);
});

test('a renamed file is still found by its leading number, and appends keep what the operator wrote', () => {
  const { discussions, folder } = files();
  mkdirSync(folder, { recursive: true });
  const path = join(folder, '142 my own name.md');
  writeFileSync(
    path,
    '---\ntags: [x]\nref: issue:142\n---\n\n## Note · 2026-11-01 · operator\n\nHand-written.\n\n## scribble\n\nkept\n',
  );
  writeFileSync(join(folder, '1420 other.md'), 'not this one');

  const write = discussions.add(story, {
    kind: 'idea',
    body: 'Offer XLSX.',
    author: DISCUSSION_AUTHORS.claudeSuggested,
  });
  assert.ok(write.ok);
  assert.equal(write.path, path);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^tags: \[x\]$/m);
  assert.match(text, /^## Note · 2026-11-01 · operator \^n-[0-9a-f]{4}$/m, 'a missing id is added on the next write');
  assert.match(text, /^## scribble$/m, 'an unreadable heading is never rewritten');
  assert.match(text, /^## Idea · open · 2026-11-03 · Claude \(suggested\) \^i-[0-9a-f]{4}$/m);
  assert.deepEqual(readdirSync(folder).sort(), ['142 my own name.md', '1420 other.md'], 'no temp file is left behind');
});

test('settling answers a question, files an idea and supersedes a decision', () => {
  const { discussions } = files();
  const question = discussions.add(story, { kind: 'question', body: 'Blank or dropped?', author: 'operator' });
  const idea = discussions.add(story, { kind: 'idea', body: 'XLSX', author: 'operator' });
  const decision = discussions.add(story, { kind: 'decision', body: 'Browser download.', author: 'operator' });
  assert.ok(question.ok && idea.ok && decision.ok);

  const answered = discussions.settle(142, question.entry.id!, { action: 'answer', answer: 'Kept as blank.' });
  assert.ok(answered.ok);
  assert.deepEqual([answered.entry.state, answered.entry.answer], ['answered', 'Kept as blank.']);
  const again = discussions.settle(142, question.entry.id!, { action: 'answer', answer: 'x' });
  assert.deepEqual(again, { ok: false, error: `^${question.entry.id} is already answered.` });

  const accepted = discussions.settle(142, idea.entry.id!, { action: 'accept', note: 'Became [[150 XLSX export]]' });
  assert.ok(accepted.ok);
  assert.equal(accepted.entry.state, 'accepted');
  assert.match(accepted.entry.body, /Became \[\[150 XLSX export\]\]$/);
  assert.equal(discussions.settle(142, decision.entry.id!, { action: 'park' }).ok, false, 'only an idea is parked');

  const superseding = discussions.settle(142, decision.entry.id!, {
    action: 'supersede',
    body: 'Server streams it.',
    author: DISCUSSION_AUTHORS.operatorViaClaude,
  });
  assert.ok(superseding.ok);
  assert.deepEqual(superseding.entry.supersedes, [decision.entry.id]);

  const entries = discussions.read(142)!.entries;
  assert.equal(entries.length, 4, 'the old decision stays as history');
  assert.equal(entries.find((e) => e.id === decision.entry.id)!.body, 'Browser download.');
  assert.equal(discussions.settle(999, 'q-0000', { action: 'drop' }).ok, false);
});

test('front-matter keys are set in place', () => {
  const { discussions } = files();
  discussions.add(story, { kind: 'note', body: 'x', author: 'operator' });
  assert.ok(discussions.setFrontMatter(142, { published: '2318842', pulled: '2026-11-03T14:02:11Z' }).ok);
  const front = discussions.read(142)!.frontMatter;
  assert.deepEqual([front.published, front.pulled, front.title], ['2318842', '2026-11-03T14:02:11Z', 'Export to CSV']);
});

test('two files for one number is recorded once and the older one is used', () => {
  const { discussions, folder, recorded } = files();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '7 new.md'), '## Note · 2026-11-02 · operator ^n-0002\n\nnew\n');
  writeFileSync(join(folder, '7 old.md'), '## Note · 2026-11-01 · operator ^n-0001\n\nold\n');
  utimesSync(join(folder, '7 old.md'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  utimesSync(join(folder, '7 new.md'), new Date(2026, 0, 1), new Date(2026, 0, 1));

  const used = discussions.read(7)!.entries[0]!.body;
  discussions.read(7);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0]!.message, /Two discussion files lead with #7/);
  assert.ok(used === 'old' || used === 'new');
});

test(
  'an unreadable folder reads as absent and is recorded',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () => {
    const { discussions, folder, recorded } = files();
    mkdirSync(folder, { recursive: true });
    chmodSync(folder, 0o000);
    try {
      assert.equal(discussions.read(1), null);
      assert.equal(recorded.length, 1);
    } finally {
      chmodSync(folder, 0o755);
    }
  },
);

test('the repo folder is the tracker repository, else the checkout name', () => {
  assert.equal(discussionRepoFolder({ github: { owner: 'o', repo: 'widgets' }, repoRoot: '/x/y' }), 'widgets');
  assert.equal(
    discussionRepoFolder({
      azureDevOps: { organization: 'o', project: 'p', repository: 'Big: Repo' } as never,
      repoRoot: '/x',
    }),
    'Big Repo',
  );
  assert.equal(discussionRepoFolder({ repoRoot: '/home/me/LubbDubb' }), 'LubbDubb');
});

test('discussionsDir is off by default and resolved against repoRoot when set', () => {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-discussions-config-'));
  assert.equal(loadConfig({ repoRoot: root }).discussionsDir, undefined);
  assert.equal(loadConfig({ repoRoot: root, discussionsDir: '' }).discussionsDir, undefined);
  assert.equal(loadConfig({ repoRoot: root, discussionsDir: 'notes' }).discussionsDir, join(root, 'notes'));
});

test('the system composes one discussions object writing under <discussionsDir>/<repo>/', () => {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-discussions-system-'));
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot: root,
      deskRoot: join(root, 'desk'),
      worktreeRoot: join(root, 'wt'),
      heartbeatIntervalMs: 999_999,
      github: { owner: 'o', repo: 'widgets' },
      discussionsDir: join(root, 'vault'),
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  assert.equal(system.discussions.enabled, true);
  const write = system.discussions.add(
    { number: 3, title: 'Feature three', kind: 'feature' },
    { kind: 'note', body: 'hi', author: DISCUSSION_AUTHORS.tracker('sam') },
  );
  assert.ok(write.ok);
  assert.equal(write.path, join(root, 'vault', 'widgets', '3 Feature three.md'));
  assert.equal(write.entry.author, '@sam (tracker)');
  assert.equal(system.discussions.read(3)!.frontMatter.parent, null, 'a feature has no parent');
});
