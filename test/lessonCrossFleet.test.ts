import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { LESSON_WINDOW_MS, lessonCandidates, type LessonGroupInputs } from '../src/lessons/groups.js';
import { LessonDesk } from '../src/lessons/lessonDesk.js';
import { LessonOutcomeDesk } from '../src/lessons/outcomeDesk.js';
import { LessonPrReading, lessonPullsOf, othersLessonPrs } from '../src/lessons/lessonPrs.js';
import type { LessonPrReadable } from '../src/integrations/integration.js';
import { lessonBranch, lessonBranchTag, lessonGroupTag, isLessonBranch } from '../src/lessons/lessonOrigin.js';
import { ticketFiler } from '../src/tickets/filing.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { LessonDraft, LessonPullRequest, Remedy, WorldSnapshot } from '../src/types.js';

// → docs/spec/41-repo-lessons.md#across-fleets

const KEY = 'ci/missed_gate/lint';
const NOW = Date.parse('2026-06-30T00:00:00Z');
const SINCE = new Date(NOW - LESSON_WINDOW_MS).toISOString();

let seq = 0;
function remedy(prNumber: number, createdAt = '2026-06-10T00:00:00.000Z'): Remedy {
  seq += 1;
  return {
    id: `rem-${seq}`,
    kind: 'ci',
    originRef: `pr:${prNumber}:ci`,
    prNumber,
    cause: 'missed_gate',
    guard: 'undocumented',
    summary: 'lint',
    checks: ['lint'],
    agentId: 'a',
    taskId: `task-${seq}`,
    createdAt,
    updatedAt: createdAt,
  };
}

function inputs(remedies: Remedy[]): LessonGroupInputs {
  return { remedies, threadLabels: [], goalOfPr: new Map(), excludedPrs: new Set(), reviewAreas: [], since: SINCE };
}

function theirs(state: LessonPullRequest['state'], closedAt: string | null = null, key = KEY): LessonPullRequest {
  return { number: 900, branch: lessonBranch('their-draft', key), url: 'https://x/pull/900', state, closedAt };
}

test('a lesson branch carries its group tag, the same on every fleet', () => {
  const branch = lessonBranch('d1', KEY);
  assert.equal(branch, `lesson/${lessonGroupTag(KEY)}/d1`);
  assert.equal(lessonBranchTag(branch), lessonGroupTag(KEY));
  assert.equal(lessonBranchTag('lesson/d1'), null, 'a branch cut before the tag carries none');
  assert.ok(isLessonBranch(branch));
  assert.notEqual(lessonGroupTag(KEY), lessonGroupTag('ci/missed_gate/test'));
});

test('another fleet’s lesson for the group: open holds it, merged ends it, closed waits for as many new goals', () => {
  const old = inputs([remedy(11), remedy(12)]);
  assert.equal(lessonCandidates(old, [], 2).length, 1);
  assert.equal(lessonCandidates(old, [], 2, [theirs('open')]).length, 0, 'open elsewhere');
  assert.equal(lessonCandidates(old, [], 2, [theirs('merged', '2026-06-15T00:00:00.000Z')]).length, 0, 'adopted');
  assert.equal(lessonCandidates(old, [], 2, [theirs('open', null, 'ci/missed_gate/test')]).length, 1, 'other group');
  assert.equal(
    lessonCandidates(old, [], 2, [{ ...theirs('open'), branch: 'lesson/legacy' }]).length,
    1,
    'an untagged branch names no group',
  );

  const closed = theirs('closed', '2026-06-15T00:00:00.000Z');
  assert.equal(lessonCandidates(old, [], 2, [closed]).length, 0, 'the misses it was declined on do not count');
  const later = inputs([remedy(11), remedy(12), remedy(13, '2026-06-20T00:00:00.000Z')]);
  assert.equal(lessonCandidates(later, [], 2, [closed]).length, 0, 'one new goal is not enough');
  const enough = inputs([...later.remedies, remedy(14, '2026-06-21T00:00:00.000Z')]);
  assert.equal(lessonCandidates(enough, [], 2, [closed]).length, 1, 'minGoals new goals redraft it');
});

test('the fleet’s own lesson pull requests are not read as another fleet’s', () => {
  const own = { id: 'mine', groupKey: KEY } as LessonDraft;
  const mine: LessonPullRequest = { ...theirs('open'), branch: lessonBranch('mine', KEY) };
  assert.deepEqual(othersLessonPrs([mine, theirs('open')], [own]), [theirs('open')]);
});

test('a provider listing is reduced to its lesson branches, open and closed, whoever authored them', () => {
  const prs = lessonPullsOf(
    [
      { number: 1, branch: lessonBranch('a', KEY), url: 'u1' },
      { number: 2, branch: 'issue/2', url: 'u2' },
    ],
    [
      { number: 3, branch: lessonBranch('b', KEY), url: 'u3', merged: true, closedAt: '2026-06-01T00:00:00Z' },
      { number: 4, branch: lessonBranch('c', KEY), url: 'u4', merged: false, closedAt: '2026-06-02T00:00:00Z' },
    ],
  );
  assert.deepEqual(
    prs.map((p) => [p.number, p.state]),
    [
      [1, 'open'],
      [3, 'merged'],
      [4, 'closed'],
    ],
  );
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lessons-x-'));
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
      lessons: { minGoals: 2 },
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(), errorMirror: () => {} },
  );
}

function miss(system: System, prNumber: number): void {
  system.store.remedies.recordRemedy({
    kind: 'ci',
    originRef: `pr:${prNumber}:ci`,
    prNumber,
    cause: 'missed_gate',
    guard: 'undocumented',
    summary: 'lint',
    checks: ['lint'],
    agentId: 'a',
    taskId: `task-${prNumber}`,
  });
}

const EMPTY: WorldSnapshot = { takenAt: new Date().toISOString(), pullRequests: [], issues: [] };

function source(prs: LessonPullRequest[] | Error): LessonPrReadable & { reads: number } {
  const s = {
    reads: 0,
    listLessonPullRequests: async () => {
      s.reads += 1;
      if (prs instanceof Error) throw prs;
      return prs;
    },
  };
  return s;
}

function desk(system: System, lessonPrs: LessonPrReading): LessonDesk {
  return new LessonDesk({ store: system.store, minGoals: 2, reviewAreas: [], lessonLabel: 'ld-lesson', lessonPrs });
}

test('the desk never waits on the read: nothing before the first, nothing while another fleet holds the group', async () => {
  const system = build();
  try {
    miss(system, 11);
    miss(system, 12);
    const held = new LessonPrReading({ source: source([theirs('open')]) });
    desk(system, held).run(EMPTY);
    assert.equal(system.store.lessons.pendingDraft(), null, 'an unread repository is not an empty one');
    await held.read();
    desk(system, held).run(EMPTY);
    assert.equal(system.store.lessons.pendingDraft(), null, 'held by the other fleet');

    const failing = new LessonPrReading({ source: source(new Error('down')) });
    assert.equal(await failing.read(), null);
    desk(system, failing).run(EMPTY);
    assert.equal(system.store.lessons.pendingDraft(), null, 'a failed read is not an empty repository');

    const read = source([]);
    const reading = new LessonPrReading({ source: read });
    await reading.read();
    desk(system, reading).run(EMPTY);
    assert.equal(system.store.lessons.pendingDraft()?.groupKey, KEY);
    assert.equal(read.reads, 1, 'a fresh read is held, not re-listed');
  } finally {
    system.store.close();
  }
});

test('a failed read keeps the last good one', async () => {
  let fail = false;
  const reading = new LessonPrReading({
    source: {
      listLessonPullRequests: async () => {
        if (fail) throw new Error('down');
        return [theirs('open')];
      },
    },
  });
  await reading.read();
  fail = true;
  assert.equal(await reading.read(), null, 'the caller learns the fresh read failed');
  assert.deepEqual(reading.held(), [theirs('open')], 'the desk keeps what it last knew');
});

test('a lesson another fleet opened first settles this draft with nothing, and no pull request is opened', async () => {
  const system = build();
  try {
    miss(system, 11);
    miss(system, 12);
    await system.lessonPrs.read();
    system.lessons.run(EMPTY);
    const draft = system.store.lessons.pendingDraft()!;
    system.store.lessons.claimDraft(draft.id, 'task-x');
    const opened: unknown[] = [];
    const deleted: unknown[] = [];
    const sink = new Proxy(
      {},
      {
        get: (_t, name) =>
          name === 'then'
            ? undefined
            : async (input: unknown) => {
                if (name === 'createPullRequest') opened.push(input);
                if (name === 'deleteBranch') deleted.push(input);
                return { ok: true, ref: '77' };
              },
      },
    ) as ActionSink;
    const outcomes = new LessonOutcomeDesk({
      store: system.store,
      sink,
      filing: ticketFiler(system.config, sink),
      refUrl: () => null,
      defaultBranch: 'main',
      watchLabel: 'ld-watch',
      lessonLabel: 'ld-lesson',
      lessonPrs: new LessonPrReading({ source: source([theirs('open')]) }),
    });
    const branch = lessonBranch(draft.id, KEY);
    const task = { id: 'task-x', originRef: `lessons:draft:${draft.id}`, branch } as Parameters<
      typeof outcomes.conclude
    >[0];
    const result = await outcomes.conclude(task, {
      outcome: 'pull_request',
      fix: 'note',
      title: 'Run lint before pushing',
      summary: '',
      reason: '',
    });
    assert.deepEqual(result, { ok: true, outcome: 'nothing', coveredBy: 'https://x/pull/900' });
    assert.equal(opened.length, 0);
    assert.deepEqual(deleted, [{ branch }], 'the pushed branch is not left behind');
    const after = system.store.lessons.getDraft(draft.id)!;
    assert.equal(after.status, 'nothing');
    assert.match(after.reason ?? '', /https:\/\/x\/pull\/900/);
  } finally {
    system.store.close();
  }
});

test('lesson_conclude opens nothing when it cannot read the other lessons, and opens on the task’s own branch', async () => {
  const system = build();
  try {
    miss(system, 11);
    miss(system, 12);
    await system.lessonPrs.read();
    system.lessons.run(EMPTY);
    const draft = system.store.lessons.pendingDraft()!;
    system.store.lessons.claimDraft(draft.id, 'task-y');
    const opened: { branch: string }[] = [];
    const sink = new Proxy(
      {},
      {
        get: (_t, name) =>
          name === 'then'
            ? undefined
            : async (input: { branch: string }) => {
                if (name === 'createPullRequest') opened.push(input);
                return { ok: true, ref: '77' };
              },
      },
    ) as ActionSink;
    let fail = true;
    const outcomes = new LessonOutcomeDesk({
      store: system.store,
      sink,
      filing: ticketFiler(system.config, sink),
      refUrl: () => null,
      defaultBranch: 'main',
      watchLabel: 'ld-watch',
      lessonLabel: 'ld-lesson',
      lessonPrs: new LessonPrReading({
        source: {
          listLessonPullRequests: async () => {
            if (fail) throw new Error('down');
            return [];
          },
        },
      }),
    });
    const legacy = `lesson/${draft.id}`;
    const task = { id: 'task-y', originRef: `lessons:draft:${draft.id}`, branch: legacy } as Parameters<
      typeof outcomes.conclude
    >[0];
    const input = { outcome: 'pull_request', fix: 'note', title: 'Run lint', summary: '', reason: '' } as const;
    const refused = await outcomes.conclude(task, input);
    assert.equal(refused.ok, false);
    assert.equal(opened.length, 0, 'an unread repository is not an empty one');
    fail = false;
    const result = await outcomes.conclude(task, input);
    assert.equal(result.ok, true);
    assert.deepEqual(
      opened.map((o) => o.branch),
      [legacy],
      'the branch the agent was given, not one re-derived',
    );
  } finally {
    system.store.close();
  }
});
