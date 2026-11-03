import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_PLANNING, planOrigin } from '../src/plans/planning.js';
import { partOrigin } from '../src/plans/parts.js';
import { parseDiscussion } from '../src/discussions/parse.js';
import { questionHold } from '../src/discussions/questionHold.js';
import type { DiscussionReader } from '../src/discussions/reader.js';
import { DISCUSSION_AUTHORS } from '../src/discussions/discussionFile.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { discussionView } from '../src/dispatcher/ruleDispatcherStage.js';
import type { DiscussionDocument, Issue, IssueRelative } from '../src/types.js';
import { failAppraisalOpen, onePartPlanRows, spentAppraisalAttempts } from './support/plans.js';

// → docs/spec/40-discussions.md#an-open-question-holds-the-story

const FEATURE: IssueRelative = {
  number: 87,
  title: 'Reporting',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
};

function story(number: number, parent: IssueRelative | null = FEATURE): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: 'Do the thing.',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'User Story',
    parent,
  };
}

function doc(number: number, entries: string): DiscussionDocument {
  return { path: `/vault/repo/${number}.md`, ...parseDiscussion(`---\nref: issue:${number}\n---\n\n${entries}`) };
}

const OPEN = '## Question · open · 2026-11-03 · operator ^q-0001\n\nDrop empty columns?\n';
const ANSWERED = '## Question · answered · 2026-11-03 · operator ^q-0002\n\nKeep blanks?\n\nAnswer: yes\n';

function reader(files: Record<number, DiscussionDocument>): DiscussionReader {
  return (n) => files[n] ?? null;
}

test('an open question on the story holds it, planned or not', () => {
  const read = reader({ 142: doc(142, OPEN) });
  assert.deepEqual(questionHold(read, story(142), false), { count: 1, paths: ['/vault/repo/142.md'] });
  assert.deepEqual(questionHold(read, story(142), true), { count: 1, paths: ['/vault/repo/142.md'] });
});

test('an open question on the feature holds only a story with no plan yet', () => {
  const read = reader({ 87: doc(87, OPEN + '\n' + OPEN.replace('q-0001', 'q-0003')) });
  assert.deepEqual(questionHold(read, story(142), false), { count: 2, paths: ['/vault/repo/87.md'] });
  assert.equal(questionHold(read, story(142), true), null, 'a planned story carries on');
});

test("the feature is found from the file's parent link when the world names none", () => {
  const own = { path: '/vault/repo/142.md', ...parseDiscussion('---\nparent: "[[87 Reporting]]"\n---\n') };
  const read = reader({ 142: own, 87: doc(87, OPEN) });
  assert.equal(questionHold(read, story(142, null), false)?.count, 1);
});

test('it fails open on every arm', () => {
  assert.equal(questionHold(undefined, story(142), false), null, 'discussions off');
  assert.equal(
    questionHold(() => null, story(142), false),
    null,
    'no file, or a file that could not be read',
  );
  assert.equal(questionHold(reader({ 142: doc(142, ANSWERED) }), story(142), false), null, 'nothing still open');
  assert.equal(
    questionHold(
      reader({ 142: doc(142, '## Questoin · open · whenever\n\nnot a heading the parser reads\n') }),
      story(142),
      false,
    ),
    null,
    'an unreadable heading is a note, never a question',
  );
});

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: '2026-07-25T12:00:00.000Z', pullRequests: [], issues: [story(142)] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    recentDecisions: spentAppraisalAttempts(142),
    ...over,
  };
}

const decide = (over: Partial<DispatchContext>) =>
  new RuleDispatcher({ defaultBranch: 'main', planning: DEFAULT_PLANNING }).decide(ctx(over));

test('the planner is queued as held on questions, with the count and the file in its reason', async () => {
  const held = await decide({ discussion: reader({ 142: doc(142, OPEN) }) });
  assert.deepEqual(
    held.actions.map((a) => a.type),
    ['no_op'],
  );
  const item = held.upcoming?.find((i) => i.origin === planOrigin(142));
  assert.equal(item?.status, 'questions');
  assert.match(item?.reason ?? '', /waiting on 1 open question — answer it in \/vault\/repo\/142\.md/);

  const answered = await decide({ discussion: reader({ 142: doc(142, ANSWERED) }) });
  assert.equal(answered.actions[0]?.rule, 'issue-plan');
  const off = await decide({});
  assert.equal(off.actions[0]?.rule, 'issue-plan', 'with discussions off nothing is held');
});

test('a part is held by its own story’s question, never by its feature’s', async () => {
  const rows = onePartPlanRows(142);
  const part = partOrigin(142, 'whole');
  const own = await decide({ ...rows, discussion: reader({ 142: doc(142, OPEN) }) });
  assert.equal(own.upcoming?.find((i) => i.origin === part)?.status, 'questions');
  assert.ok(!own.actions.some((a) => a.type === 'dispatch_code_agent'));

  const feature = await decide({ ...rows, discussion: reader({ 87: doc(87, OPEN) }) });
  assert.equal(feature.upcoming?.find((i) => i.origin === part)?.status, 'dispatching');
});

test('a priority override lifts the hold — the operator saying go outranks the question', async () => {
  const lifted = await decide({
    discussion: reader({ 142: doc(142, OPEN) }),
    priorityOverrides: [{ origin: planOrigin(142), rank: 0 }],
  });
  assert.equal(lifted.actions[0]?.rule, 'issue-plan');
});

test('through the system: a question holds the planner until it is answered, then the answer is in its prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discussion-hold-'));
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
    prediction: { enabled: false },
    goalCriteria: { enabled: false },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Export to CSV', body: 'Please.' });
  failAppraisalOpen(system.store, 1);
  const asked = system.discussions.add(
    { number: 1, title: 'Export to CSV', kind: 'story' },
    { kind: 'question', body: 'Drop empty columns?', author: DISCUSSION_AUTHORS.agent('issue-plan', 't1') },
  );
  assert.ok(asked.ok);

  await system.harness.runCycle('manual');
  const planned = (): boolean => system.store.tasks.listTasks().some((t) => t.originRef === planOrigin(1));
  assert.equal(planned(), false, 'the open question holds the planner');
  const queued = system.harness.upcoming?.items.find((i) => i.origin === planOrigin(1));
  assert.equal(queued?.status, 'questions');

  const answer = system.discussions.settle(1, asked.entry.id!, { action: 'answer', answer: 'Keep them blank.' });
  assert.ok(answer.ok);
  await system.harness.runCycle('manual');
  const planner = system.store.tasks.listTasks().find((t) => t.originRef === planOrigin(1));
  assert.ok(planner, 'answering the last question lets the story start');
  const prompt = system.store.tasks.getTask(planner.id)?.prompt ?? '';
  assert.match(prompt, /\*\*Discussion\*\*/);
  assert.match(prompt, /Drop empty columns\?/);
  assert.match(prompt, /Answer: Keep them blank\./);
  system.store.close();
});

test('through the system: an unreadable folder fails open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discussion-open-'));
  const vault = join(dir, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, basename(dir)), 'a file where the repo folder should be');
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: dir,
    discussionsDir: vault,
    heartbeatIntervalMs: 999_999,
    prediction: { enabled: false },
    goalCriteria: { enabled: false },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Export to CSV', body: 'Please.' });
  failAppraisalOpen(system.store, 1);
  await system.harness.runCycle('manual');
  assert.ok(system.store.tasks.listTasks().some((t) => t.originRef === planOrigin(1)));
  system.store.close();
});

test('a Feature under an Epic is not held by the Epic, and is not handed its decisions', () => {
  const epic: IssueRelative = {
    number: 1,
    title: 'Platform',
    issueType: 'Epic',
    workItemState: 'Active',
    state: 'open',
  };
  const feature: Issue = { ...story(87, epic), title: 'Reporting', issueType: 'Feature' };
  const read = reader({
    1: doc(1, `${OPEN}\n## Decision · 2026-11-01 · operator ^d-0001\n\nEpic-wide.\n`),
    87: doc(87, ''),
    142: doc(142, ''),
  });
  const view = discussionView(
    { discussion: read } as unknown as DispatchContext,
    new Map(),
    new Map(),
    new Map([
      [87, feature],
      [142, story(142)],
    ]),
    undefined,
  );
  assert.equal(view.issueHold(87), null, 'the Epic’s question does not hold the Feature');
  assert.doesNotMatch(view.discussionNote(87), /Epic-wide/);
  assert.equal(view.issueHold(142), null, 'nor its story, which pairs with the Feature only');
});
