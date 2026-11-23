import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { lessonPrBody } from '../src/lessons/evidence.js';
import { githubRefUrl } from '../src/integrations/github/refUrl.js';
import { buildLessonInsights } from '../src/insights/lessonInsights.js';
import { buildRemedyInsights } from '../src/insights/remedyInsights.js';
import { DAY_MS } from '../src/primitives.js';
import type { Agent, LessonDraft, RetroMiss, Task, WorldSnapshot } from '../src/types.js';
import { findTask } from './support/tasks.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';

// → docs/spec/41-repo-lessons.md#retrospective-misses

const BILLING = 'services/billing/invoice.cs';

function build(minGoals = 2): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-retro-lessons-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: 'ld',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 5,
      lessons: { minGoals, parentWorkItem: null },
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(), errorMirror: () => {} },
  );
}

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { takenAt: new Date().toISOString(), pullRequests: [], issues: [], ...over };
}

function retroAgent(system: System, issue: number): Agent {
  const task = system.store.tasks.createTask({
    kind: 'desk',
    title: `Write up issue #${issue}`,
    prompt: 'write it up',
    branch: null,
    originRef: `issue:${issue}:retro`,
    originTitle: `Issue ${issue}`,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function submit(system: System, issue: number, misses: unknown): Promise<{ isError: boolean; text: string }> {
  const session = system.mcp.session(retroAgent(system, issue).id);
  assert.ok(session);
  const result = (await session.call('retro_submit', {
    summary: `Issue ${issue} shipped.`,
    document: '# How it went',
    misses,
  })) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

function billingMiss(summary = 'nobody wrote down that invoices round half-even') {
  return { cause: 'convention', guard: 'undocumented', path: BILLING, summary };
}

/** A review round on `pr` under `issue`, whose one code-changing thread was in billing. */
function reviewRound(system: System, issue: number, pr: number): void {
  system.store.graph.recordWorkGraph([
    { ref: `issue:${issue}`, kind: 'issue', title: `Issue ${issue}`, status: 'open', terminal: false },
    { ref: `pr:${pr}`, kind: 'pr', parentRef: `issue:${issue}`, title: `PR ${pr}`, status: 'open', terminal: false },
  ]);
  const taskId = `task-review-${pr}`;
  system.store.remedies.recordRemedy({
    kind: 'review',
    originRef: `pr:${pr}:comments`,
    prNumber: pr,
    cause: 'convention',
    guard: 'undocumented',
    summary: `reviewer asked for half-even rounding on pr ${pr}`,
    checks: [],
    agentId: 'agent-r',
    taskId,
  });
  system.store.prThreadLabels.recordThreadLabel({
    prNumber: pr,
    threadId: `thread-${pr}`,
    aboutComment: false,
    changedCode: true,
    resolved: true,
    path: 'services/billing/tax.cs',
    author: 'reviewer',
    authorIsBot: false,
    agentId: 'agent-r',
    taskId,
  });
}

async function draftAndDispatch(system: System): Promise<{ draft: LessonDraft; task: Task | null }> {
  await system.lessonPrs.read();
  system.lessons.run(world());
  await system.harness.runCycle('manual');
  const draft = system.store.lessons.listDrafts()[0]!;
  return { draft, task: findTask(system.store, (t) => t.rule === 'repo-lesson') ?? null };
}

test('retro misses alone, on two goals, draft a lesson whose briefing labels them as retrospective evidence', async () => {
  const system = build();
  try {
    assert.equal((await submit(system, 1, [billingMiss()])).isError, false);
    assert.equal(
      (await submit(system, 2, [billingMiss('half-even rounding again, found by reading tests')])).isError,
      false,
    );

    const { draft, task } = await draftAndDispatch(system);
    assert.equal(draft.groupKey, 'review/convention/services/billing');
    assert.deepEqual(draft.goals, ['issue:1', 'issue:2']);
    assert.deepEqual(
      draft.misses.map((m) => m.source),
      ['retro', 'retro'],
    );
    assert.ok(task, 'one repo-lesson agent');
    const evidence = task.prompt.slice(task.prompt.indexOf('## The evidence'));
    assert.match(evidence, /0 from remedies .* and 2 from goal retrospectives/s);
    assert.match(
      evidence,
      /From the retrospective:\n\n- services\/billing\/invoice\.cs \(undocumented\): nobody wrote down/,
    );
    assert.doesNotMatch(evidence, /From remedies:/);

    const body = lessonPrBody(draft, { fix: 'note', summary: '', reason: '' }, (ref) =>
      githubRefUrl('acme', 'shop', ref),
    );
    assert.match(body, /goal retrospectives recorded a miss in code under `services\/billing\/`/);
    assert.doesNotMatch(body, /review asked for changes/);
    assert.match(body, /### What goal retrospectives recorded/);
    assert.ok(body.includes('https://github.com/acme/shop/issues/1'));
    assert.doesNotMatch(body, /#\d/);
  } finally {
    system.store.close();
  }
});

test('a review remedy on one goal and a retro miss on another form one group across both sources', async () => {
  const system = build();
  try {
    reviewRound(system, 1, 11);
    await submit(system, 2, [billingMiss()]);

    const { draft, task } = await draftAndDispatch(system);
    assert.equal(draft.groupKey, 'review/convention/services/billing');
    assert.deepEqual(draft.goals, ['issue:1', 'issue:2']);
    assert.deepEqual(draft.misses.map((m) => m.source).sort(), ['remedy', 'retro']);
    assert.ok(task);
    const evidence = task.prompt.slice(task.prompt.indexOf('## The evidence'));
    assert.match(evidence, /1 from remedies .* and 1 from goal retrospectives/s);
    assert.match(evidence, /### issue:1[\s\S]*From remedies:\n\n- pr:11 \(undocumented\)/);
    assert.match(evidence, /### issue:2[\s\S]*From the retrospective:\n\n- services\/billing\/invoice\.cs/);

    const body = lessonPrBody(draft, { fix: 'note', summary: '', reason: '' }, (ref) =>
      githubRefUrl('acme', 'shop', ref),
    );
    assert.match(body, /review asked for changes and goal retrospectives recorded a miss/);
    assert.match(body, /Evidence: 1 from remedies, 1 from goal retrospectives/);
  } finally {
    system.store.close();
  }
});

test('a retro miss and a remedy on the same goal count as one goal toward lessons.minGoals', async () => {
  const system = build();
  try {
    reviewRound(system, 1, 11);
    await submit(system, 1, [billingMiss()]);
    await system.lessonPrs.read();
    system.lessons.run(world());
    assert.equal(system.store.lessons.listDrafts().length, 0, 'two sources on one goal are one miss');

    await submit(system, 2, [billingMiss()]);
    system.lessons.run(world());
    const [draft] = system.store.lessons.listDrafts();
    assert.ok(draft);
    assert.deepEqual(draft.goals, ['issue:1', 'issue:2']);
    assert.equal(draft.misses.length, 3, 'every account is evidence, though the goals are two');
  } finally {
    system.store.close();
  }
});

test('retro misses on a lesson ticket the fleet took on, or with an ungrouped guard, are left out', async () => {
  const system = build();
  try {
    await submit(system, 1, [billingMiss()]);
    await submit(system, 2, [billingMiss()]);
    await submit(system, 3, [{ ...billingMiss(), guard: 'local_check' }]);
    await system.lessonPrs.read();
    const lessonTicket = {
      id: 'i2',
      number: 2,
      title: 'Lesson',
      body: '',
      labels: ['ld-lesson'],
      state: 'open' as const,
      linkedPrNumber: null,
    };
    system.lessons.run(world({ issues: [lessonTicket] }));
    assert.equal(system.store.lessons.listDrafts().length, 0, 'one goal left once the lesson ticket is out');
  } finally {
    system.store.close();
  }
});

test('retro_submit refuses a miss off the fixed lists, and a rewrite replaces the goal’s misses', async () => {
  const system = build(0);
  try {
    const badCause = await submit(system, 1, [{ ...billingMiss(), cause: 'missed_gate' }]);
    assert.equal(badCause.isError, true, 'a CI cause names a check, not a file');
    for (const path of ['../etc/passwd', '/abs/file.ts', 'src/api/', 'src/a`b.ts'])
      assert.equal((await submit(system, 1, [{ ...billingMiss(), path }])).isError, true, path);
    const tooMany = await submit(
      system,
      1,
      Array.from({ length: 6 }, () => billingMiss()),
    );
    assert.equal(tooMany.isError, true);

    await submit(system, 1, [billingMiss(), { ...billingMiss(), cause: 'clarity' }]);
    assert.equal(system.store.scratch.listRetroMissesSince('1970-01-01').length, 2);
    const dated = system.store.scratch.listRetroMissesSince('1970-01-01').map((m) => m.createdAt);
    assert.deepEqual(
      dated,
      [0, 1].map(() => system.store.scratch.getRetrospective('issue:1')!.createdAt),
    );
    await submit(system, 1, undefined);
    assert.equal(system.store.scratch.listRetroMissesSince('1970-01-01').length, 2, 'left out keeps them');
    await submit(system, 1, [billingMiss()]);
    assert.deepEqual(
      system.store.scratch.listRetroMissesSince('1970-01-01').map((m) => m.createdAt),
      [dated[0]],
      'a rewrite never re-dates a miss',
    );
    await submit(system, 1, []);
    assert.equal(system.store.scratch.listRetroMissesSince('1970-01-01').length, 0, 'replaced whole');
    system.store.scratch.recordRetrospective({
      originRef: 'issue:9',
      summary: 's',
      document: 'd',
      agentId: 'a',
      taskId: 't',
    });
    assert.deepEqual(
      system.store.scratch.listRetrospectivesWrittenSince('1970-01-01').map((r) => r.originRef),
      ['issue:1'],
      'a retrospective that never answered the misses question is no occasion to miss on',
    );
    assert.ok(system.store.scratch.getRetrospective('issue:1'), 'the retrospective itself stands');
  } finally {
    system.store.close();
  }
});

test('the retrospective prompt asks for misses below the rendered template', async () => {
  const takenAt = '2026-07-30T12:00:00.000Z';
  const plan = await new RuleDispatcher().decide({
    world: {
      takenAt,
      pullRequests: [],
      issues: [
        { id: 'i12', number: 12, title: 'Add it', body: 'add it', labels: [], state: 'open', linkedPrNumber: null },
      ],
    },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    deliveries: [
      {
        originRef: 'issue:12',
        summary: 'delivered',
        detail: null,
        by: 'assessor',
        agentId: 'a1',
        taskId: 't1',
        decidedAt: takenAt,
        updatedAt: takenAt,
      },
    ],
  });
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:retro');
  assert.ok(action && 'prompt' in action && typeof action.prompt === 'string');
  const ask = action.prompt.indexOf('also pass `misses`');
  assert.ok(ask > action.prompt.indexOf('Then call retro_submit'), 'appended after the template, never interpolated');
});

const MERGED = Date.parse('2026-06-01T00:00:00Z');
const at = (days: number) => new Date(MERGED + days * DAY_MS).toISOString();

function retroMiss(originRef: string, days: number): RetroMiss {
  return {
    id: `rtm-${originRef}-${days}`,
    originRef,
    cause: 'convention',
    guard: 'undocumented',
    path: BILLING,
    summary: 'missed',
    agentId: 'a',
    taskId: 't',
    createdAt: at(days),
  };
}

test('did it work reads a review lesson’s retro misses, labelled, with retrospectives as returns', () => {
  const draft: LessonDraft = {
    id: 'lsn_1',
    groupKey: 'review/convention/services/billing',
    kind: 'review',
    cause: 'convention',
    where: 'services/billing',
    goals: ['issue:1', 'issue:2'],
    misses: [],
    status: 'adopted',
    taskId: null,
    fix: 'note',
    title: 'Write down rounding',
    summary: null,
    reason: null,
    prNumber: 90,
    ticketRef: null,
    createdAt: at(-2),
    settledAt: at(0),
  };
  const read = (retroSince: string | null) =>
    buildLessonInsights({
      drafts: [draft],
      remedies: [],
      retroMisses: [retroMiss('issue:1', -10), retroMiss('issue:2', -5), retroMiss('issue:3', 5)],
      threadLabels: [],
      goalOfPr: new Map(),
      excludedPrs: new Set([90]),
      excludedGoals: new Set(['issue:99']),
      reviewAreas: [],
      returnDispatches: [-10, -5, -3, -1, 5, 6].map((days) => ({
        prNumber: null,
        goal: days === -1 ? 'issue:99' : `issue:${days}`,
        kind: 'review' as const,
        createdAt: at(days),
      })),
      now: MERGED + 31 * DAY_MS,
      retroSince,
    });
  const insights = read(at(-40));
  const row = insights.drafts[0]!;
  assert.deepEqual(row.before, { misses: 2, returns: 3 });
  assert.deepEqual(row.after, { misses: 1, returns: 2 });
  assert.deepEqual(row.fromRetros, { before: 2, after: 1 });
  const straddled = read(at(-5)).drafts[0]!;
  assert.deepEqual(
    [straddled.before, straddled.after],
    [
      { misses: 0, returns: 0 },
      { misses: 0, returns: 0 },
    ],
    'a lesson whose before side predates misses reads retro evidence on neither side',
  );
  assert.equal(row.verdict, 'working');
});

test('the Causes reading carries retro misses apart from the remedy accounts', () => {
  const insights = buildRemedyInsights({
    remedies: [],
    retroMisses: [retroMiss('issue:1', 0), { ...retroMiss('issue:1', 1), cause: 'clarity', guard: 'documented' }],
    returnDispatches: [],
    usageEvents: [],
  });
  assert.equal(insights.accounts, 0, 'never summed into the accounts');
  assert.equal(insights.retros.misses, 2);
  assert.equal(insights.retros.goals, 1);
  assert.equal(insights.retros.byCause.find((c) => c.cause === 'convention')?.undocumented, 1);
  assert.deepEqual(
    insights.retros.recent.map((r) => [r.ref, r.path]),
    [
      ['issue:1', BILLING],
      ['issue:1', BILLING],
    ],
  );
});
