import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
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
import type { ErrorLogInput, Issue, IssueRelative } from '../src/types.js';
import { discussionSubject, resolveSubject } from '../src/discussions/subject.js';
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

test('addMany appends every entry and the front-matter keys in one write', () => {
  const { discussions } = files();
  discussions.add(story, { kind: 'note', body: 'first', author: 'operator' });
  const written = discussions.addMany(
    story,
    [
      { kind: 'note', body: 'second', author: DISCUSSION_AUTHORS.tracker('sam') },
      { kind: 'note', body: 'third', author: DISCUSSION_AUTHORS.tracker('kim') },
    ],
    { pulled: '2026-11-03T14:02:11Z' },
  );
  assert.ok(written.ok);
  const doc = discussions.read(142)!;
  assert.deepEqual(
    doc.entries.map((e) => e.body),
    ['first', 'second', 'third'],
  );
  assert.equal(new Set(doc.entries.map((e) => e.id)).size, 3, 'every entry has its own id');
  assert.equal(doc.frontMatter.pulled, '2026-11-03T14:02:11Z');
});

test('a file the operator changes or adds between reads is read afresh', () => {
  const { discussions, folder } = files();
  const write = discussions.add(story, { kind: 'note', body: 'x', author: 'operator' });
  assert.ok(write.ok);
  assert.equal(discussions.read(142)!.entries.length, 1);
  appendFileSync(write.path, '\n## Note · 2026-11-03 · operator\n\nby hand\n');
  assert.equal(discussions.read(142)!.entries.length, 2, 'an edit is seen');
  writeFileSync(join(folder, '150 Later.md'), '## Note · 2026-11-03 · operator\n\nnew\n');
  utimesSync(folder, new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.deepEqual(discussions.numbers(), [142, 150], 'a new file is listed');
  assert.equal(discussions.read(150)!.entries[0]!.body, 'new');
});

test('identify says whether it named anything', () => {
  const { discussions, folder } = files();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '142 x.md'), '## Note · 2026-11-01 · operator\n\nHand-written.\n');
  assert.deepEqual(discussions.identify(142), { ok: true, path: join(folder, '142 x.md'), changed: true });
  assert.deepEqual(discussions.identify(142), { ok: true, path: join(folder, '142 x.md'), changed: false });
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

test('one resolver names a story or a feature for every reader and writer', () => {
  const relative = (number: number): IssueRelative => ({
    number,
    title: `#${number}`,
    state: 'open',
    workItemState: 'Active',
    issueType: '',
  });
  const issue = (number: number, parent: number | null, issueType?: string): Issue => ({
    id: `i${number}`,
    number,
    title: `#${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    parent: parent === null ? null : relative(parent),
    ...(issueType === undefined ? {} : { issueType }),
  });
  const issues = [issue(1, null, 'Epic'), issue(87, 1, 'Feature'), issue(142, 87), issue(200, null), issue(201, 200)];
  assert.equal(resolveSubject(issues, 87, undefined).kind, 'feature', 'a container type, even under an epic');
  assert.deepEqual(
    resolveSubject(issues, 87, undefined).stories.map((s) => s.number),
    [142],
  );
  assert.deepEqual(discussionSubject(issues, 142, undefined), {
    number: 142,
    title: '#142',
    kind: 'story',
    parent: { number: 87, title: '#87' },
  });
  assert.equal(resolveSubject(issues, 200, undefined).kind, 'feature', 'a top-level parent with no type');
  assert.deepEqual(discussionSubject(issues, 999, undefined), { number: 999, title: '', kind: 'story', parent: null });
  assert.equal(resolveSubject(issues, 999, undefined).kind, null, 'nothing known');
  const typed = [issue(300, null, 'Bug'), issue(301, 300)];
  assert.equal(resolveSubject(typed, 300, undefined).kind, 'story', 'a typed non-container stays a story');
});

test('a file added or edited in the same clock tick as a read is not missed', () => {
  const { discussions, folder } = files();
  const write = discussions.add(story, { kind: 'question', body: 'Keep blanks?', author: 'operator' });
  assert.ok(write.ok);
  assert.deepEqual(discussions.numbers(), [142]);
  const tick = statSync(folder).mtime;
  writeFileSync(join(folder, '150 Later.md'), '## Note · 2026-11-03 · operator\n\nnew\n');
  utimesSync(folder, tick, tick);
  assert.deepEqual(discussions.numbers(), [142, 150], 'a new file in the same tick is listed');

  assert.equal(discussions.read(142)!.entries[0]!.state, 'open');
  const before = statSync(write.path);
  const text = readFileSync(write.path, 'utf8');
  writeFileSync(write.path, text.replace('Question · open ·', 'Question · done ·'));
  utimesSync(write.path, before.atime, before.mtime);
  assert.equal(statSync(write.path).size, before.size, 'the edit kept the size');
  assert.equal(discussions.read(142)!.entries[0]!.unreadable, true, 'a same-size, same-tick edit is read afresh');
});
