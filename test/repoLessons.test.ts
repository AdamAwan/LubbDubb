import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildTools } from '../src/mcp/tools.js';
import { resolveOpenPr } from '../src/mcp/openPr.js';
import { toolsForRule } from '../src/mcp/names.js';
import { LessonOutcomeDesk } from '../src/lessons/outcomeDesk.js';
import { lessonPrBody, type RefUrl } from '../src/lessons/evidence.js';
import { lessonBranch, lessonMarker } from '../src/lessons/lessonOrigin.js';
import { isHarnessBranch } from '../src/pr/prOwnership.js';
import { ticketFiler } from '../src/tickets/filing.js';
import { githubRefUrl } from '../src/integrations/github/refUrl.js';
import { azureRefUrl } from '../src/integrations/azure/refUrl.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { LessonDraft, PullRequest, Task, WorldSnapshot } from '../src/types.js';

// → docs/spec/41-repo-lessons.md

interface SinkCall {
  method: string;
  input: Record<string, unknown>;
}

function recordingSink(): { sink: ActionSink; calls: SinkCall[] } {
  const calls: SinkCall[] = [];
  const sink = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (name.startsWith('can')) return () => true;
        return async (input: Record<string, unknown>) => {
          calls.push({ method: name, input });
          if (name === 'createPullRequest') return { ok: true, ref: '77' };
          if (name === 'createIssue') return { ok: true, ref: '88' };
          return { ok: true };
        };
      },
    },
  ) as ActionSink;
  return { sink, calls };
}

function build(minGoals: number, backend = new FakePtyBackend()): { system: System; calls: SinkCall[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lessons-'));
  const { sink, calls } = recordingSink();
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: 'ld',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      lessons: { minGoals },
    }),
    { backend, sink, worktrees: new FakeWorktreeManager(), errorMirror: () => {} },
  );
  return { system, calls };
}

function miss(system: System, prNumber: number, check = 'lint', summary = `lint rule no-floating on pr ${prNumber}`) {
  return system.store.remedies.recordRemedy({
    kind: 'ci',
    originRef: `pr:${prNumber}:ci`,
    prNumber,
    cause: 'missed_gate',
    guard: 'undocumented',
    summary,
    checks: [check],
    agentId: 'agent-x',
    taskId: `task-${prNumber}-${check}`,
  });
}

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR ${number}`,
    branch: `issue/${number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { takenAt: new Date().toISOString(), pullRequests: [], issues: [], ...over };
}

function lessonTasks(system: System): Task[] {
  return system.store.tasks
    .listTasks()
    .filter((t) => t.rule === 'repo-lesson')
    .map((t) => system.store.tasks.getTask(t.id)!);
}

async function dispatched(system: System): Promise<{ task: Task; draft: LessonDraft }> {
  miss(system, 11);
  miss(system, 12);
  await system.lessons.run(world());
  await system.harness.runCycle('manual');
  const tasks = lessonTasks(system);
  assert.equal(tasks.length, 1);
  const draft = system.store.lessons.listDrafts()[0]!;
  return { task: tasks[0]!, draft };
}

function concludeTool(system: System, task: Task, desk: LessonOutcomeDesk = system.lessonOutcomes) {
  const agent = system.store.agents.getAgent(task.agentId!)!;
  const tool = buildTools({ store: system.store, agents: system.agents, lessons: () => desk }, { agent, task }).find(
    (t) => t.name === 'lesson_conclude',
  );
  assert.ok(tool);
  return tool;
}

const GITHUB: RefUrl = (ref) => githubRefUrl('acme', 'shop', ref);
const AZURE: RefUrl = (ref) => azureRefUrl('acme', 'Shop', 'shop', ref);

test('remedies on two goals put one repo-lesson agent on lesson/<tag>/<id>, with the evidence appended', async () => {
  const { system } = build(2);
  try {
    const { task, draft } = await dispatched(system);
    assert.equal(task.branch, lessonBranch(draft.id, draft.groupKey));
    assert.equal(task.originRef, `lessons:draft:${draft.id}`);
    assert.equal(draft.groupKey, 'ci/missed_gate/lint');
    assert.equal(draft.status, 'dispatched');
    assert.equal(draft.goals.length, 2);
    const evidence = task.prompt.indexOf('## The evidence');
    assert.ok(evidence > task.prompt.indexOf('lesson_conclude'), 'the evidence follows the rendered template');
    assert.match(task.prompt.slice(evidence), /pr:11 \(undocumented\): lint rule no-floating on pr 11/);
    assert.ok(toolsForRule('repo-lesson').has('lesson_conclude'));
    assert.ok(!toolsForRule('pr-ci-failing').has('lesson_conclude'), 'advertised to the lesson agent alone');

    await system.lessons.run(world());
    await system.harness.runCycle('manual');
    assert.equal(lessonTasks(system).length, 1, 'no second draft while one is out');
    assert.equal(system.store.lessons.listDrafts().length, 1);
  } finally {
    system.store.close();
  }
});

test('minGoals 0 drafts nothing, the rule is inert even over a draft row, and the row is settled', async () => {
  const { system } = build(0);
  try {
    miss(system, 11);
    miss(system, 12);
    await system.lessons.run(world());
    assert.equal(system.store.lessons.listDrafts().length, 0);
    system.store.lessons.openDraft({
      groupKey: 'ci/missed_gate/lint',
      kind: 'ci',
      cause: 'missed_gate',
      where: 'lint',
      goals: ['pr:11', 'pr:12'],
      misses: [],
      briefing: '',
    });
    await system.harness.runCycle('manual');
    assert.equal(lessonTasks(system).length, 0);
    await system.lessons.run(world());
    assert.deepEqual(
      system.store.lessons.listDrafts().map((d) => d.status),
      ['unanswered'],
    );
  } finally {
    system.store.close();
  }
});

test('lesson_conclude refuses a task that is not the draft’s, and open_pr refuses a lesson origin', async () => {
  const { system } = build(2);
  try {
    const { task } = await dispatched(system);
    const elsewhere = await system.lessonOutcomes.conclude(
      { ...task, originRef: 'issue:5' },
      { outcome: 'nothing', fix: null, title: '', summary: '', reason: 'taste' },
    );
    assert.equal(elsewhere.ok, false);
    const stolen = await system.lessonOutcomes.conclude(
      { ...task, id: 'someone-else' },
      { outcome: 'nothing', fix: null, title: '', summary: '', reason: 'taste' },
    );
    assert.equal(stolen.ok, false, 'the draft’s own task, not any task on its origin');

    const refused = resolveOpenPr(task.originRef, { issues: [], plan: null, parts: [], defaultBranch: 'main' });
    assert.ok('error' in refused && refused.error.includes('lesson_conclude'));
    assert.ok(!('error' in refused && /open it yourself/i.test(refused.error)));
    assert.equal(isHarnessBranch(task.branch!), true, 'a lesson branch is the harness’s own');
  } finally {
    system.store.close();
  }
});

test('a pull_request outcome opens the PR with URL citations and the marker, labels it lesson and watches it', async () => {
  const { system, calls } = build(2);
  try {
    const { task, draft } = await dispatched(system);
    const desk = new LessonOutcomeDesk({
      store: system.store,
      sink: system.sink,
      filing: ticketFiler(system.config, system.sink),
      refUrl: GITHUB,
      defaultBranch: 'main',
      watchLabel: 'ld-watch',
      lessonLabel: 'ld-lesson',
    });
    const tool = concludeTool(system, task, desk);
    const titled = await tool.handler({ outcome: 'pull_request', fix: 'guard', title: 'Lint: see #12' });
    assert.equal(titled.isError, true, 'a title naming a pull request is refused');
    const result = await tool.handler({
      outcome: 'pull_request',
      fix: 'guard',
      title: 'Enforce no-floating in lint',
      summary: 'Added the rule.',
      reason: 'Documented and still missed.',
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));

    const opened = calls.find((c) => c.method === 'createPullRequest')!.input;
    assert.equal(opened.branch, lessonBranch(draft.id, draft.groupKey));
    assert.equal(opened.base, 'main');
    const body = String(opened.body);
    assert.ok(body.includes('https://github.com/acme/shop/pull/11'));
    assert.ok(body.includes('https://github.com/acme/shop/pull/12'));
    assert.ok(body.includes(lessonMarker('ci/missed_gate/lint')));
    assert.doesNotMatch(body, /#\d/);
    assert.ok(!body.includes('Added the rule.'), 'the body is the harness’s evidence, not the agent’s prose');
    const labels = calls.filter((c) => c.method === 'setPrLabel').map((c) => c.input);
    assert.deepEqual(
      labels.map((l) => [l.prNumber, l.label]),
      [
        [77, 'ld-lesson'],
        [77, 'ld-watch'],
      ],
    );
    const after = system.store.lessons.getDraft(draft.id)!;
    assert.equal(after.status, 'pr-open');
    assert.equal(after.prNumber, 77);
    assert.equal((await tool.handler({ outcome: 'nothing', reason: 'again' })).isError, true, 'once only');
  } finally {
    system.store.close();
  }
});

test('a ticket outcome files with the lesson label, no watch label and the search key, and settles filed', async () => {
  const { system, calls } = build(2);
  try {
    const { task, draft } = await dispatched(system);
    const result = await concludeTool(system, task).handler({
      outcome: 'ticket',
      fix: 'code',
      title: 'Merge the two lint configs',
      summary: 'The repository has two lint configs that drift.',
      reason: 'Touches every package.',
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const filed = calls.find((c) => c.method === 'createIssue')!.input;
    assert.deepEqual(filed.labels, ['ld-lesson']);
    assert.equal(filed.searchKey, 'lesson:ci/missed_gate/lint');
    assert.match(String(filed.body), /two lint configs that drift/);
    const after = system.store.lessons.getDraft(draft.id)!;
    assert.equal(after.status, 'filed');
    assert.equal(after.ticketRef, '88');
    assert.ok(after.settledAt);
  } finally {
    system.store.close();
  }
});

test('nothing settles the draft with its reason; a task that ends unconcluded settles it unanswered', async () => {
  const { system } = build(2);
  try {
    const { task, draft } = await dispatched(system);
    const tool = concludeTool(system, task);
    assert.equal((await tool.handler({ outcome: 'nothing' })).isError, true, 'nothing needs a reason');
    assert.equal((await tool.handler({ outcome: 'nothing', reason: 'A matter of taste.' })).isError, undefined);
    const after = system.store.lessons.getDraft(draft.id)!;
    assert.equal(after.status, 'nothing');
    assert.equal(after.reason, 'A matter of taste.');
  } finally {
    system.store.close();
  }

  const backend = new FakePtyBackend();
  const second = build(2, backend);
  try {
    const { draft } = await dispatched(second.system);
    backend.last().emitExit(0);
    await delay(5);
    await second.system.lessons.run(world());
    assert.equal(second.system.store.lessons.getDraft(draft.id)!.status, 'unanswered');
  } finally {
    second.system.store.close();
  }
});

function prOpen(system: System, key: string, where: string, prNumber: number): LessonDraft {
  const draft = system.store.lessons.openDraft({
    groupKey: key,
    kind: 'ci',
    cause: 'missed_gate',
    where,
    goals: ['pr:1', 'pr:2'],
    misses: [],
    briefing: '',
  })!;
  system.store.lessons.claimDraft(draft.id, `task-${draft.id}`);
  system.store.lessons.concludePr(draft.id, prNumber, { fix: 'guard', title: 't', summary: null, reason: null });
  return draft;
}

test('a merged lesson pull request is adopted, a closed one declined', async () => {
  const { system } = build(2);
  try {
    const merged = prOpen(system, 'ci/missed_gate/a', 'a', 77);
    const closed = prOpen(system, 'ci/missed_gate/b', 'b', 78);
    const settled = world({
      closedPullRequests: [
        pr(77, { branch: `lesson/${merged.id}`, merged: true, state: 'merged' }),
        pr(78, { branch: `lesson/${closed.id}`, state: 'closed' }),
      ],
    });
    system.graph.record(settled);
    await system.lessons.run(settled);
    assert.equal(system.store.lessons.getDraft(merged.id)!.status, 'adopted');
    assert.equal(system.store.lessons.getDraft(closed.id)!.status, 'declined');
  } finally {
    system.store.close();
  }
});

test('at most two lesson pull requests are open, and an open PR carrying the marker holds its group', async () => {
  const { system } = build(2);
  try {
    prOpen(system, 'ci/missed_gate/a', 'a', 77);
    prOpen(system, 'ci/missed_gate/b', 'b', 78);
    miss(system, 11);
    miss(system, 12);
    await system.lessons.run(world());
    assert.equal(system.store.lessons.pendingDraft(), null, 'the cap of two holds');
  } finally {
    system.store.close();
  }

  const other = build(2).system;
  try {
    miss(other, 11);
    miss(other, 12);
    await other.lessons.run(world({ pullRequests: [pr(40, { body: `x\n\n${lessonMarker('ci/missed_gate/lint')}` })] }));
    assert.equal(other.store.lessons.pendingDraft(), null, 'another fleet’s open lesson for the group');
    await other.lessons.run(world({ pullRequests: [pr(11, { botAuthored: true })] }));
    assert.equal(other.store.lessons.pendingDraft(), null, 'a bot’s pull request is not the fleet’s miss');
    await other.lessons.run(world());
    assert.equal(other.store.lessons.pendingDraft()?.groupKey, 'ci/missed_gate/lint');
  } finally {
    other.store.close();
  }
});

test('a declined group is redrafted only after as many new goals again; an adopted one never', async () => {
  const { system } = build(2);
  try {
    miss(system, 11);
    miss(system, 12);
    await system.lessons.run(world());
    const first = system.store.lessons.pendingDraft()!;
    system.store.lessons.settle(first.id, 'declined', ['pending']);
    await delay(5);
    await system.lessons.run(world());
    assert.equal(system.store.lessons.pendingDraft(), null, 'the misses it was declined on do not bring it back');
    miss(system, 13);
    await system.lessons.run(world());
    assert.equal(system.store.lessons.pendingDraft(), null, 'one new goal is not as many again');
    miss(system, 14);
    await system.lessons.run(world());
    const again = system.store.lessons.pendingDraft();
    assert.ok(again, 'two new goals redraft it');
    assert.equal(again.groupKey, first.groupKey);

    system.store.lessons.settle(again.id, 'adopted', ['pending']);
    await delay(5);
    miss(system, 15);
    miss(system, 16);
    await system.lessons.run(world());
    assert.equal(system.store.lessons.pendingDraft(), null, 'an adopted lesson is never redrafted');
  } finally {
    system.store.close();
  }
});

test('both providers cite every pull request as a full URL, never #n and never with a closing keyword', () => {
  const draft: LessonDraft = {
    id: 'lsn_1',
    groupKey: 'review/convention/src/api',
    kind: 'review',
    cause: 'convention',
    where: 'src/api',
    goals: ['issue:4', 'issue:5'],
    misses: [
      { remedyId: 'r1', prNumber: 31, goal: 'issue:4', guard: 'documented', summary: 'fixes #4 by renaming' },
      { remedyId: 'r2', prNumber: 32, goal: 'issue:5', guard: 'undocumented', summary: 'closes #5' },
    ],
    status: 'dispatched',
    taskId: 't',
    fix: null,
    title: null,
    summary: null,
    reason: null,
    prNumber: null,
    ticketRef: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    settledAt: null,
  };
  const github = lessonPrBody(draft, 'note', GITHUB);
  assert.ok(github.includes('https://github.com/acme/shop/pull/31'));
  assert.ok(github.includes('https://github.com/acme/shop/pull/32'));
  const azure = lessonPrBody(draft, 'note', AZURE);
  assert.ok(azure.includes('https://dev.azure.com/acme/Shop/_git/shop/pullrequest/31'));
  assert.ok(azure.includes('https://dev.azure.com/acme/Shop/_git/shop/pullrequest/32'));
  for (const body of [github, azure]) {
    assert.doesNotMatch(body, /#\d/);
    assert.doesNotMatch(body, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+(#|https?:)/i);
    assert.ok(body.endsWith(lessonMarker('review/convention/src/api')));
  }
});
