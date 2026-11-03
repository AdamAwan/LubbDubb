import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { DEFAULT_PR_REVIEW } from '../src/review/policy.js';
import { findTask } from './support/tasks.js';
import { parseDiscussion } from '../src/discussions/parse.js';
import { discussionNoteFor, discussionSection } from '../src/discussions/promptSection.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { DiscussionDocument, Issue } from '../src/types.js';
import { onePartPlanRows, spentAppraisalAttempts } from './support/plans.js';

// → docs/spec/40-discussions.md#what-agents-read

function doc(number: number, entries: string): DiscussionDocument {
  return { path: `/vault/repo/${number}.md`, ...parseDiscussion(`---\nref: issue:${number}\n---\n\n${entries}`) };
}

const STORY = doc(
  142,
  [
    '## Decision · 2026-11-01 · operator ^d-0001',
    '',
    'Export uses a server-side file.',
    '',
    '## Decision · 2026-11-02 · operator ^d-0002',
    '',
    'Export uses the browser download.',
    '',
    'Supersedes ^d-0001',
    '',
    '## Idea · accepted · 2026-11-02 · operator ^i-0001',
    '',
    'Name the file after the report.',
    '',
    '## Idea · parked · 2026-11-02 · operator ^i-0002',
    '',
    'Offer XLSX as well.',
    '',
    '## Question · answered · 2026-11-03 · agent issue-plan#t1 ^q-0001',
    '',
    'Drop empty columns?',
    '',
    'Answer: Keep them blank.',
    '',
    '## Note · 2026-11-03 · operator ^n-0001',
    '',
    'The older note.',
    '',
    '## Note · 2026-11-03 · operator ^n-0002',
    '',
    'The newer note.',
    '',
  ].join('\n'),
);

const FEATURE = doc(87, '## Decision · 2026-10-30 · operator ^d-0100\n\nEvery report exports the same way.\n');

test('the section runs decisions (story, then feature), accepted ideas, answered questions, then notes newest first', () => {
  const section = discussionSection(STORY, FEATURE);
  const order = [
    '**Discussion**',
    'Export uses the browser download.',
    'Every report exports the same way.',
    'Name the file after the report.',
    'Drop empty columns?',
    'Answer: Keep them blank.',
    'The newer note.',
    'The older note.',
  ].map((needle) => section.indexOf(needle));
  assert.ok(
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)),
    `out of order: ${order.join(',')}`,
  );
  assert.ok(section.startsWith('\n\n---\n\n'), 'appended, never interpolated');
  assert.match(section, /\/vault\/repo\/142\.md/);
  assert.doesNotMatch(section, /server-side file/, 'a superseded decision is not handed over');
  assert.doesNotMatch(section, /XLSX/, 'a parked idea is history');
});

test('notes are cut at the budget, newest kept, with how many were left out and where the file is', () => {
  const notes = Array.from(
    { length: 40 },
    (_, i) => `## Note · 2026-11-03 · operator ^n-${String(i).padStart(4, '0')}\n\nnote ${i} ${'x'.repeat(300)}\n`,
  ).join('\n');
  const section = discussionSection(doc(142, notes), null);
  assert.ok(section.length <= 6000, `section is ${section.length} characters`);
  assert.match(section, /note 39 /, 'the newest note is kept');
  assert.doesNotMatch(section, /note 0 /, 'the oldest is the one cut');
  assert.match(
    section,
    /\d+ older notes left out to keep this short — the whole discussion is in \/vault\/repo\/142\.md/,
  );
});

test('decisions are never cut, whatever the budget', () => {
  const decisions = Array.from(
    { length: 30 },
    (_, i) =>
      `## Decision · 2026-11-03 · operator ^d-${String(i).padStart(4, '0')}\n\ndecision ${i} ${'y'.repeat(300)}\n`,
  ).join('\n');
  const section = discussionSection(doc(142, decisions), null);
  for (let i = 0; i < 30; i++) assert.match(section, new RegExp(`decision ${i} `));
});

test('nothing is appended with no file, discussions off, or nothing to hand over', () => {
  assert.equal(discussionSection(null, null), '');
  assert.equal(discussionNoteFor(undefined, 142, 87), '');
  assert.equal(
    discussionNoteFor(() => null, 142, 87),
    '',
  );
  assert.equal(discussionSection(doc(142, '## Question · open · 2026-11-03 · operator\n\nAsk.\n'), null), '');
});

function issue(number: number): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: 'Do the thing.',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    parent: { number: 87, title: 'Reporting', issueType: 'Feature', workItemState: 'Active', state: 'open' },
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: '2026-07-25T12:00:00.000Z', pullRequests: [], issues: [issue(142)] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    recentDecisions: spentAppraisalAttempts(142),
    discussion: (n) => ({ 142: STORY, 87: FEATURE })[n] ?? null,
    ...over,
  };
}

const dispatcher = () => new RuleDispatcher({ defaultBranch: 'main', planning: DEFAULT_PLANNING });

function promptOf(actions: { type: string }[], rule: string): string {
  const action = actions.find((a) => a.type === 'dispatch_code_agent' && (a as { rule?: string }).rule === rule);
  return (action as { prompt?: string } | undefined)?.prompt ?? '';
}

test('the planner and a part are each handed the section', async () => {
  const planned = await dispatcher().decide(ctx());
  assert.match(promptOf(planned.actions, 'issue-plan'), /Export uses the browser download\./);

  const part = await dispatcher().decide(ctx(onePartPlanRows(142)));
  assert.match(promptOf(part.actions, 'plan-part'), /Every report exports the same way\./);
});

test("through the system: the reviewer of a story's pull request is handed the story's section", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discussion-prompt-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: dir,
    discussionsDir: join(dir, 'vault'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    review: { ...DEFAULT_PR_REVIEW, enabled: true },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 142, title: 'Export to CSV', body: 'Please.' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Export to CSV', branch: 'issue/142/whole' });
  const written = system.discussions.add(
    { number: 142, title: 'Export to CSV', kind: 'story' },
    { kind: 'idea', state: 'accepted', body: 'Name the file after the report.', author: 'operator' },
  );
  assert.ok(written.ok);
  await system.harness.runCycle('manual');
  const review = findTask(system.store, (t) => t.originRef === 'pr:7:review');
  assert.ok(review);
  assert.match(system.store.tasks.getTask(review.id)?.prompt ?? '', /Name the file after the report\./);
  system.store.close();
});
