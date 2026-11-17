import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LESSON_WINDOW_MS,
  lessonCandidates,
  lessonGroupKey,
  lessonGroups,
  type LessonGroupInputs,
  type PriorDraft,
} from '../src/lessons/groups.js';
import { prGoalIndex } from '../src/graph/prGoals.js';
import type { PrThreadLabel, Remedy, WorkNode } from '../src/types.js';

// → docs/spec/41-repo-lessons.md

const NOW = Date.parse('2026-06-30T00:00:00Z');
const SINCE = new Date(NOW - LESSON_WINDOW_MS).toISOString();

let seq = 0;

function remedy(over: Partial<Remedy> & Pick<Remedy, 'prNumber'>): Remedy {
  seq += 1;
  const kind = over.kind ?? 'ci';
  return {
    id: `rem-${seq}`,
    kind,
    originRef: `pr:${over.prNumber}:${kind === 'ci' ? 'ci' : 'comments'}`,
    cause: kind === 'ci' ? 'missed_gate' : 'convention',
    guard: 'undocumented',
    summary: 'something was missed',
    checks: kind === 'ci' ? ['lint'] : [],
    agentId: `agent-${seq}`,
    taskId: `task-${seq}`,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

function thread(over: Partial<PrThreadLabel> & Pick<PrThreadLabel, 'prNumber' | 'taskId'>): PrThreadLabel {
  seq += 1;
  return {
    threadId: `t-${seq}`,
    aboutComment: false,
    changedCode: true,
    resolved: true,
    path: 'src/store/tasks.ts',
    author: 'reviewer',
    authorIsBot: false,
    agentId: 'agent',
    answeredAt: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

function inputs(over: Partial<LessonGroupInputs> = {}): LessonGroupInputs {
  return {
    remedies: [],
    threadLabels: [],
    goalOfPr: new Map(),
    excludedPrs: new Set(),
    reviewAreas: [
      { area: 'sql', path: '^src/store/' },
      { area: 'ui', path: '^web/src/' },
    ],
    since: SINCE,
    ...over,
  };
}

function node(ref: string, kind: WorkNode['kind'], parentRef: string | null): WorkNode {
  return {
    ref,
    kind,
    parentRef,
    baseRef: null,
    title: ref,
    status: 'open',
    terminal: false,
    provenance: null,
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    lastSeenAt: '2026-06-01T00:00:00.000Z',
  };
}

test('prGoalIndex walks a pull request up its parent chain to the issue root', () => {
  const index = prGoalIndex([
    node('issue:7', 'issue', null),
    node('plan:a', 'plan', 'issue:7'),
    node('pr:11', 'pr', 'plan:a'),
    node('pr:12', 'pr', 'issue:7'),
    node('job:x', 'job', null),
    node('pr:13', 'pr', 'job:x'),
  ]);
  assert.deepEqual([...index.entries()].sort(), [
    [11, 'issue:7'],
    [12, 'issue:7'],
  ]);
});

test('a CI remedy joins one group per check, keyed kind/cause/where', () => {
  const groups = lessonGroups(inputs({ remedies: [remedy({ prNumber: 1, checks: ['lint', 'test', 'lint'] })] }));
  assert.deepEqual(groups.map((g) => g.key).sort(), ['ci/missed_gate/lint', 'ci/missed_gate/test']);
  assert.equal(lessonGroupKey('ci', 'missed_gate', 'lint'), 'ci/missed_gate/lint');
});

test('only documented and undocumented guards count, and the noisy causes never do', () => {
  const remedies = [
    remedy({ prNumber: 1, guard: 'local_check' }),
    remedy({ prNumber: 1, guard: 'unpreventable' }),
    remedy({ prNumber: 1, cause: 'flake' }),
    remedy({ prNumber: 1, cause: 'environment' }),
    remedy({ prNumber: 1, cause: 'inherited' }),
    remedy({ prNumber: 1, cause: 'defect' }),
    remedy({ prNumber: 1, cause: 'other' }),
    remedy({ prNumber: 1, cause: 'stale_test', guard: 'documented' }),
  ];
  const groups = lessonGroups(inputs({ remedies }));
  assert.deepEqual(
    groups.map((g) => g.key),
    ['ci/stale_test/lint'],
  );
  assert.deepEqual(groups[0]!.remedyIds, [remedies.at(-1)!.id]);
});

test('remedies outside the window, on bot-authored or on lesson pull requests are left out', () => {
  const remedies = [
    remedy({ prNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
    remedy({ prNumber: 2 }),
    remedy({ prNumber: 3 }),
  ];
  const groups = lessonGroups(inputs({ remedies, excludedPrs: new Set([2]) }));
  assert.deepEqual(groups[0]!.remedyIds, [remedies[2]!.id]);
});

test('goals are counted distinct, with a pull request outside the graph standing as its own pr:<n>', () => {
  const remedies = [remedy({ prNumber: 1 }), remedy({ prNumber: 2 }), remedy({ prNumber: 3 }), remedy({ prNumber: 3 })];
  const goalOfPr = new Map([
    [1, 'issue:10'],
    [2, 'issue:10'],
  ]);
  const [group] = lessonGroups(inputs({ remedies, goalOfPr }));
  assert.deepEqual(group!.goals, ['issue:10', 'pr:3']);
  assert.equal(group!.remedyIds.length, 4);
});

test('a review remedy is placed by the areas of the threads its task changed code for', () => {
  const r = remedy({ prNumber: 4, kind: 'review', taskId: 'task-review' });
  const threadLabels = [
    thread({ prNumber: 4, taskId: 'task-review', path: 'src/store/tasks.ts' }),
    thread({ prNumber: 4, taskId: 'task-review', path: 'web/src/App.tsx' }),
    thread({ prNumber: 4, taskId: 'task-review', path: 'src/store/plans.ts' }),
    thread({ prNumber: 4, taskId: 'task-review', path: 'lib/defended.ts', changedCode: false }),
    thread({ prNumber: 4, taskId: 'task-review', path: null }),
    thread({ prNumber: 4, taskId: 'task-other', path: 'docs/x.md' }),
  ];
  const groups = lessonGroups(inputs({ remedies: [r], threadLabels }));
  assert.deepEqual(groups.map((g) => g.key).sort(), ['review/convention/sql', 'review/convention/ui']);
  for (const g of groups) assert.deepEqual(g.remedyIds, [r.id], 'a round across two areas counts once in each');
});

test('a path no area rule claims falls back to its first two directories', () => {
  const r = remedy({ prNumber: 5, kind: 'review', taskId: 'task-fallback' });
  const threadLabels = [
    thread({ prNumber: 5, taskId: 'task-fallback', path: 'services/billing/invoice/total.cs' }),
    thread({ prNumber: 5, taskId: 'task-fallback', path: 'app/main.py' }),
    thread({ prNumber: 5, taskId: 'task-fallback', path: 'README.md' }),
  ];
  const groups = lessonGroups(inputs({ remedies: [r], threadLabels }));
  assert.deepEqual(groups.map((g) => g.where).sort(), ['.', 'app', 'services/billing']);
});

test('a review remedy with no anchored code-changing thread joins no group', () => {
  const r = remedy({ prNumber: 6, kind: 'review' });
  assert.deepEqual(lessonGroups(inputs({ remedies: [r] })), []);
});

const twoGoals = (): LessonGroupInputs =>
  inputs({
    remedies: [remedy({ prNumber: 1 }), remedy({ prNumber: 2 })],
    goalOfPr: new Map([
      [1, 'issue:1'],
      [2, 'issue:2'],
    ]),
  });

test('a group is a candidate once it spans minGoals distinct goals, and not before', () => {
  assert.deepEqual(
    lessonCandidates(twoGoals(), [], 2).map((c) => c.key),
    ['ci/missed_gate/lint'],
  );
  assert.deepEqual(lessonCandidates(twoGoals(), [], 3), []);
  const sameGoal = inputs({
    remedies: [remedy({ prNumber: 1 }), remedy({ prNumber: 2 })],
    goalOfPr: new Map([
      [1, 'issue:1'],
      [2, 'issue:1'],
    ]),
  });
  assert.deepEqual(lessonCandidates(sameGoal, [], 2), [], 'two pull requests of one goal are one miss');
});

const draft = (status: PriorDraft['status'], settledAt: string | null, goals = 2): PriorDraft => ({
  groupKey: 'ci/missed_gate/lint',
  status,
  goals: Array.from({ length: goals }, (_, i) => `issue:${String(i + 1)}`),
  settledAt,
});

test('a group with a live draft, or one adopted or filed, is not drafted again', () => {
  for (const status of ['pending', 'dispatched', 'pr-open'] as const) {
    assert.deepEqual(lessonCandidates(twoGoals(), [draft(status, null)], 2), [], status);
  }
  for (const status of ['adopted', 'filed'] as const) {
    assert.deepEqual(lessonCandidates(twoGoals(), [draft(status, '2026-01-01T00:00:00.000Z')], 2), [], status);
  }
});

test('a declined, nothing or unanswered draft is redrafted only once as many new goals have missed since', () => {
  const settled = '2026-06-10T00:00:00.000Z';
  const remedies = [
    remedy({ prNumber: 1, createdAt: '2026-06-05T00:00:00.000Z' }),
    remedy({ prNumber: 2, createdAt: '2026-06-06T00:00:00.000Z' }),
    remedy({ prNumber: 3, createdAt: '2026-06-15T00:00:00.000Z' }),
  ];
  const goalOfPr = new Map([
    [1, 'issue:1'],
    [2, 'issue:2'],
    [3, 'issue:3'],
  ]);
  for (const status of ['declined', 'nothing', 'unanswered'] as const) {
    assert.deepEqual(lessonCandidates(inputs({ remedies, goalOfPr }), [draft(status, settled)], 2), [], status);
  }

  const more = [...remedies, remedy({ prNumber: 4, createdAt: '2026-06-16T00:00:00.000Z' })];
  goalOfPr.set(4, 'issue:4');
  const [again] = lessonCandidates(inputs({ remedies: more, goalOfPr }), [draft('declined', settled)], 2);
  assert.equal(again?.key, 'ci/missed_gate/lint');

  assert.deepEqual(
    lessonCandidates(inputs({ remedies: more, goalOfPr }), [draft('declined', settled, 3)], 2),
    [],
    'the bar is the larger of the goals it was drafted on and minGoals',
  );
});

test('the latest settled draft sets the bar, and candidates rank by goals spanned', () => {
  const remedies = [
    remedy({ prNumber: 1, createdAt: '2026-06-05T00:00:00.000Z' }),
    remedy({ prNumber: 2, createdAt: '2026-06-12T00:00:00.000Z' }),
    remedy({ prNumber: 3, createdAt: '2026-06-13T00:00:00.000Z' }),
    remedy({ prNumber: 1, checks: ['test'] }),
    remedy({ prNumber: 2, checks: ['test'] }),
    remedy({ prNumber: 3, checks: ['test'] }),
    remedy({ prNumber: 4, checks: ['test'] }),
  ];
  const goalOfPr = new Map<number, string>();
  const drafts = [draft('declined', '2026-06-01T00:00:00.000Z'), draft('unanswered', '2026-06-11T00:00:00.000Z')];
  const candidates = lessonCandidates(inputs({ remedies, goalOfPr }), drafts, 2);
  assert.deepEqual(
    candidates.map((c) => [c.key, c.goals.length]),
    [
      ['ci/missed_gate/test', 4],
      ['ci/missed_gate/lint', 3],
    ],
  );
});
