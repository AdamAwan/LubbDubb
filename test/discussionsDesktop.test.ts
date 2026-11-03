import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import type { DesktopChange } from '../src/mcp/desktopContext.js';
import type { IssueCommentInput, SendResult } from '../src/sink/actionSink.js';
import type { Issue, IssueRelative } from '../src/types.js';
import { desktopDeps } from './support/desktop.js';

const NOW = '2026-11-03T12:00:00.000Z';

const FEATURE: IssueRelative = {
  number: 500,
  title: 'Reporting',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
};

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    parent: FEATURE,
    ...over,
  };
}

interface Deck {
  system: System;
  changes: DesktopChange[];
  posted: IssueCommentInput[];
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; json: ReturnType<typeof JSON.parse> }>;
}

function deck(over: { discussionsDir?: string | null; refuseComment?: boolean } = {}): Deck {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discuss-desktop-'));
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
      github: { owner: 'acme', repo: 'widgets' } as never,
      ...(over.discussionsDir === null ? {} : { discussionsDir: over.discussionsDir ?? join(dir, 'vault') }),
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  system.store.world.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    issues: [issue(500, { title: 'Reporting', issueType: 'Feature', parent: null }), issue(11), issue(12)],
  });
  const changes: DesktopChange[] = [];
  const posted: IssueCommentInput[] = [];
  system.connector.upsertIssueComment = async (input: IssueCommentInput): Promise<SendResult> => {
    if (over.refuseComment) throw new Error('the tracker is down');
    posted.push(input);
    return { ok: true, ref: input.commentRef ?? `c${posted.length}` };
  };
  const tools = buildDesktopTools(
    {
      ...desktopDeps(system),
      changed: (c) => changes.push(c),
      now: () => NOW,
    },
    { label: 'adam', held: null },
  );
  return {
    system,
    changes,
    posted,
    call: async (name, args) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is on the desktop channel`);
      const result = await tool.handler(args);
      const text = result.content[0]?.text ?? '';
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // A refusal is prose.
      }
      return { isError: result.isError === true, text, json };
    },
  };
}

test('the five discussion tools are desktop tools, and none is on the fleet channel by this build', () => {
  for (const name of [
    'discussion_read',
    'discussion_add',
    'discussion_settle',
    'discussion_publish',
    'discussion_pull',
  ])
    assert.ok(DESKTOP_TOOL_NAMES.includes(name as never), `${name} is a desktop tool`);
  for (const name of ['discussion_read', 'discussion_settle', 'discussion_publish', 'discussion_pull'])
    assert.ok(!MCP_TOOL_NAMES.includes(name as never), `${name} is never the fleet's`);
});

test('off is a refusal that says how to turn it on, and nothing is written', async () => {
  const d = deck({ discussionsDir: null });
  const read = await d.call('discussion_read', { issue: 11 });
  assert.equal(read.isError, true);
  assert.match(read.text, /discussionsDir/);
  const add = await d.call('discussion_add', { issue: 11, kind: 'note', body: 'x' });
  assert.equal(add.isError, true);
  assert.equal(d.changes.length, 0);
});

test('a decision written from Claude is the operator’s via Claude, lands in the file and tells the cockpit', async () => {
  const d = deck();
  const add = await d.call('discussion_add', {
    issue: 11,
    kind: 'decision',
    body: 'Export uses the browser download.',
  });
  assert.equal(add.isError, false, add.text);
  assert.equal(add.json.written.kind, 'decision');
  assert.equal(add.json.written.author, 'operator (via Claude)');
  const text = readFileSync(add.json.file as string, 'utf8');
  assert.match(text, /ref: issue:11/);
  assert.match(text, /parent: '\[\[500 Reporting\]\]'|parent: "\[\[500 Reporting\]\]"|parent: \[\[500 Reporting\]\]/);
  assert.match(text, /## Decision · \d{4}-\d\d-\d\d · operator \(via Claude\) \^d-[0-9a-f]{4}/);
  assert.ok(d.changes.length > 0, 'the write is broadcast');
});

test('an idea Claude suggested is labelled as Claude’s, and suggested is refused on anything else', async () => {
  const d = deck();
  const idea = await d.call('discussion_add', { issue: 11, kind: 'idea', body: 'Offer XLSX too.', suggested: true });
  assert.equal(idea.isError, false, idea.text);
  assert.equal(idea.json.written.author, 'Claude (suggested)');
  assert.equal(idea.json.written.state, 'open');
  const wrong = await d.call('discussion_add', { issue: 11, kind: 'decision', body: 'x', suggested: true });
  assert.equal(wrong.isError, true);
  const bad = await d.call('discussion_add', { issue: 11, kind: 'thought', body: 'x' });
  assert.equal(bad.isError, true, 'an unknown kind is a refusal, not a write');
});

test('an issue the harness does not hold is refused rather than given a file', async () => {
  const d = deck();
  const add = await d.call('discussion_add', { issue: 9999, kind: 'note', body: 'x' });
  assert.equal(add.isError, true);
  assert.match(add.text, /#9999/);
});

test('a story read carries its feature’s standing decisions and open questions; a feature read its stories’ questions', async () => {
  const d = deck();
  await d.call('discussion_add', { issue: 500, kind: 'decision', body: 'CSV only for now.' });
  await d.call('discussion_add', { issue: 500, kind: 'question', body: 'Who owns the exporter?' });
  await d.call('discussion_add', { issue: 11, kind: 'question', body: 'Drop empty columns?' });
  await d.call('discussion_add', { issue: 11, kind: 'note', body: 'Seen in the call.' });

  const story = await d.call('discussion_read', { issue: 11 });
  assert.equal(story.isError, false, story.text);
  assert.equal(story.json.kind, 'story');
  assert.equal(story.json.entries.length, 2);
  assert.deepEqual(
    story.json.open.map((e: { body: string }) => e.body),
    ['Drop empty columns?'],
  );
  const feature = story.json.related.find((r: { number: number }) => r.number === 500);
  assert.ok(feature, 'the feature comes with the story');
  assert.deepEqual(
    feature.standingDecisions.map((e: { body: string }) => e.body),
    ['CSV only for now.'],
  );
  assert.deepEqual(
    feature.openQuestions.map((e: { body: string }) => e.body),
    ['Who owns the exporter?'],
  );

  const read = await d.call('discussion_read', { issue: 500 });
  assert.equal(read.json.kind, 'feature');
  const child = read.json.related.find((r: { number: number }) => r.number === 11);
  assert.deepEqual(
    child.openQuestions.map((e: { body: string }) => e.body),
    ['Drop empty columns?'],
  );
});

test('settle answers a question, accepts an idea and supersedes a decision — and refuses what does not fit', async () => {
  const d = deck();
  const q = await d.call('discussion_add', { issue: 11, kind: 'question', body: 'Drop empty columns?' });
  const i = await d.call('discussion_add', { issue: 11, kind: 'idea', body: 'Offer XLSX too.' });
  const dec = await d.call('discussion_add', { issue: 11, kind: 'decision', body: 'CSV only.' });

  const noText = await d.call('discussion_settle', { issue: 11, entry: q.json.written.id, action: 'answer' });
  assert.equal(noText.isError, true, 'an answer needs its text');

  const answered = await d.call('discussion_settle', {
    issue: 11,
    entry: `^${q.json.written.id as string}`,
    action: 'answer',
    text: 'Keep them, blank.',
  });
  assert.equal(answered.isError, false, answered.text);
  assert.equal(answered.json.written.state, 'answered');
  assert.equal(answered.json.written.answer, 'Keep them, blank.');

  const again = await d.call('discussion_settle', {
    issue: 11,
    entry: q.json.written.id,
    action: 'answer',
    text: 'twice',
  });
  assert.equal(again.isError, true, 'an answered question is not answered again');

  const accepted = await d.call('discussion_settle', {
    issue: 11,
    entry: i.json.written.id,
    action: 'accept',
    text: 'Became [[13 Export to XLSX]]',
  });
  assert.equal(accepted.json.written.state, 'accepted');

  const superseded = await d.call('discussion_settle', {
    issue: 11,
    entry: dec.json.written.id,
    action: 'supersede',
    text: 'CSV and XLSX.',
  });
  assert.equal(superseded.isError, false, superseded.text);
  assert.deepEqual(superseded.json.written.supersedes, [dec.json.written.id]);
  assert.equal(superseded.json.written.author, 'operator (via Claude)');

  const read = await d.call('discussion_read', { issue: 11 });
  assert.equal(read.json.open.length, 0, 'nothing is left open');
});

test('publish posts only the text it is given, records the id, and publishing again edits the same comment', async () => {
  const d = deck();
  const nothing = await d.call('discussion_publish', { issue: 11, body: 'Summary' });
  assert.equal(nothing.isError, true, 'there is no file to publish from yet');

  await d.call('discussion_add', { issue: 11, kind: 'decision', body: 'CSV only.' });
  const first = await d.call('discussion_publish', { issue: 11, body: '## Where this stands\n\nCSV only.' });
  assert.equal(first.isError, false, first.text);
  assert.deepEqual(d.posted[0], { number: 11, body: '## Where this stands\n\nCSV only.', commentRef: null });
  assert.equal(first.json.published, 'c1');

  const read = await d.call('discussion_read', { issue: 11 });
  assert.equal(read.json.published, 'c1', 'the id is in the front matter');
  assert.ok(d.system.store.issueComments.issueCommentRefs(11).has('c1'), 'and on the record of what the harness sent');

  const second = await d.call('discussion_publish', { issue: 11, body: 'Revised.' });
  assert.equal(second.isError, false, second.text);
  assert.equal(d.posted[1]!.commentRef, 'c1', 'republishing edits the comment it published');
  assert.equal(second.json.edited, true);
});

test('a tracker that refuses the comment is a refusal, and the file is left unpublished', async () => {
  const d = deck({ refuseComment: true });
  await d.call('discussion_add', { issue: 11, kind: 'note', body: 'x' });
  const sent = await d.call('discussion_publish', { issue: 11, body: 'Summary' });
  assert.equal(sent.isError, true);
  assert.match(sent.text, /tracker is down/);
  const read = await d.call('discussion_read', { issue: 11 });
  assert.equal(read.json.published, null);
});

test('discussion_pull pulls a person’s comment now and refuses an issue with no file', async () => {
  const d = deck();
  const none = await d.call('discussion_pull', { issue: 12 });
  assert.equal(none.isError, true);
  await d.call('discussion_add', { issue: 11, kind: 'note', body: 'opened' });
  d.system.connector.inject({ kind: 'issue_comment', number: 11, author: 'sam', body: 'What about XLSX?' });
  const pulled = await d.call('discussion_pull', { issue: 11 });
  assert.equal(pulled.isError, false, pulled.text);
  assert.equal(pulled.json.added, 1);
  const read = await d.call('discussion_read', { issue: 11 });
  const note = read.json.entries.find((e: { body: string }) => e.body === 'What about XLSX?');
  assert.equal(note.author, '@sam (tracker)');
});

test('a question written by hand is named by the read, so it can be answered from Claude', async () => {
  const d = deck();
  await d.call('discussion_add', { issue: 11, kind: 'note', body: 'Seen in the call.' });
  await d.call('discussion_add', { issue: 500, kind: 'note', body: 'Feature note.' });
  for (const n of [11, 500]) {
    const path = d.system.discussions.locate(n)!;
    appendFileSync(path, `\n## Question · open · 2026-11-03 · operator\n\nTyped by hand on #${n}?\n`);
  }

  const read = await d.call('discussion_read', { issue: 11 });
  const own = read.json.open.find((e: { body: string }) => e.body === 'Typed by hand on #11?');
  assert.match(own.id, /^q-[0-9a-f]{4}$/, 'the story’s hand-written question has an id');
  const feature = read.json.related.find((r: { number: number }) => r.number === 500);
  const theirs = feature.openQuestions.find((e: { body: string }) => e.body === 'Typed by hand on #500?');
  assert.match(theirs.id, /^q-[0-9a-f]{4}$/, 'the feature’s hand-written question has an id');

  const answered = await d.call('discussion_settle', { issue: 11, entry: own.id, action: 'answer', text: 'Yes.' });
  assert.equal(answered.isError, false, answered.text);
  const again = await d.call('discussion_read', { issue: 11 });
  assert.deepEqual(again.json.open, []);
});
