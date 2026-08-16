import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { priorWorkBriefing, type PriorWorkInput } from '../src/briefing/priorWork.js';
import { Store } from '../src/store/store.js';
import { gitRepo } from './support/gitRepo.js';
import { planWithOnePart } from './support/plans.js';
import type { GoalFile, Plan, ScratchEntry } from '../src/types.js';

// -- the pure briefing -------------------------------------------------------

/** A goal nobody has touched: every source empty. */
function bare(): PriorWorkInput {
  return {
    plan: null,
    parts: [],
    assay: null,
    conclusion: null,
    delivery: null,
    shortfall: null,
    entries: [],
    files: [],
    forPart: false,
  };
}

function file(fields: Partial<GoalFile> = {}): GoalFile {
  return {
    path: 'src/store/schema.ts',
    originRef: 'issue:12:part:schema',
    createdAt: '2026-07-30T10:00:00.000Z',
    ...fields,
  };
}

function planRow(fields: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Add a widget',
    status: 'active',
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    discussing: false,
    statusCommentRef: null,
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: '2026-07-30T09:00:00.000Z',
    ...fields,
  };
}

function entry(fields: Partial<ScratchEntry> = {}): ScratchEntry {
  return {
    id: 'scr_1',
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a1',
    taskId: 't1',
    topic: 'migrations',
    note: 'the column has to be added additively or older databases never see it',
    createdAt: '2026-07-30T10:00:00.000Z',
    ...fields,
  };
}

test('a goal nobody has worked yet renders nothing at all', () => {
  // The promise that makes this safe to append on *every* dispatch: a first agent's
  // prompt is byte-identical to one composed before this existed, so the briefing
  // costs nothing until there is something to say.
  assert.equal(priorWorkBriefing(bare()), '');
  assert.equal(priorWorkBriefing({ ...bare(), plan: planRow() }), '', 'a plan with no write-up says nothing');
  assert.equal(
    priorWorkBriefing({ ...bare(), parts: [{ slug: 'schema', title: 'Schema' }] as PriorWorkInput['parts'] }),
    '',
    'a part that declared neither a rationale nor an acceptance says nothing',
  );
});

test('the pad is carried over, attributed and framed as testimony rather than instruction', () => {
  const text = priorWorkBriefing({ ...bare(), entries: [entry()] });
  assert.match(text, /additively/);
  assert.match(text, /issue:12:part:schema/, 'the author is named — an agent must not read it as the harness');
  assert.match(text, /not the harness/i);
});

test("the planner's write-up reaches the agent, and its one-line reason deliberately does not", () => {
  // The module's whole rule: it carries only what no template renders. `reason` is
  // already rendered by `currentPlanSummary` to a replanner and as `{plan}` to a
  // part agent, so repeating it here would be a second account of one fact.
  const text = priorWorkBriefing({
    ...bare(),
    plan: planRow({
      reason: 'three lanes',
      diagnosis: 'the seeding proc skips IMS-only groups',
      approach: 'add the seeding rule and repair the rows already wrong',
      risks: 'the migration is the risky half',
      outOfScope: 'the cockpit panel is not in this',
      document: '## Why\n\nBecause the schema has to land first.',
    }),
  });
  // The root cause and the fix reach an agent through here and nowhere else: on a
  // `single` verdict there is no `currentPlanSummary` in the prompt at all.
  assert.match(text, /the seeding proc skips IMS-only groups/);
  assert.match(text, /add the seeding rule and repair the rows already wrong/);
  assert.match(text, /the migration is the risky half/);
  assert.match(text, /the cockpit panel is not in this/);
  assert.match(text, /the schema has to land first/);
  assert.doesNotMatch(text, /three lanes/, 'plan.reason is rendered elsewhere and must not be duplicated here');
});

test("a part's rationale and acceptance are carried — they are rendered nowhere else at all", () => {
  const parts = [
    {
      slug: 'schema',
      title: 'Schema',
      status: 'merged',
      prNumber: 41,
      rationale: 'must merge first',
      acceptance: 'the table exists',
    },
  ] as PriorWorkInput['parts'];
  const text = priorWorkBriefing({ ...bare(), parts });
  assert.match(text, /must merge first/);
  assert.match(text, /the table exists/);
  // No world facts: a PR's state is live through world_read and stale in a prompt.
  assert.doesNotMatch(text, /41/, 'the briefing carries testimony, never world state');
  assert.doesNotMatch(text, /merged/, 'a part status is world state, and siblingContext already renders it');
});

test('a part agent is not told about the parts, because siblingContext already tells it', () => {
  const parts = [
    { slug: 'schema', title: 'Schema', rationale: 'must merge first', acceptance: null },
  ] as PriorWorkInput['parts'];
  assert.match(priorWorkBriefing({ ...bare(), parts, forPart: false }), /must merge first/);
  assert.equal(
    priorWorkBriefing({ ...bare(), parts, forPart: true }),
    '',
    'the `plan-part` prompt renders every sibling; a second rendering in one prompt reads as two',
  );
});

test('the prose behind each standing verdict is carried, with who cast it', () => {
  const text = priorWorkBriefing({
    ...bare(),
    assay: {
      originRef: 'issue:12',
      verdict: 'workable',
      summary: 'the goal names a concrete table',
      goalRef: 'fingerprint',
      by: 'assayer',
      proposedProfile: null,
      profileAnsweredAt: null,
      agentId: 'a1',
      taskId: 't1',
      commentRef: null,
      decidedAt: '2026-07-30T08:00:00.000Z',
      updatedAt: '2026-07-30T08:00:00.000Z',
    },
    conclusion: {
      originRef: 'issue:12',
      verdict: 'done',
      note: 'the widget ships behind a flag',
      by: 'agent',
      agentId: 'a2',
      taskId: 't2',
      createdAt: '2026-07-30T09:00:00.000Z',
      updatedAt: '2026-07-30T09:00:00.000Z',
    },
    shortfall: {
      originRef: 'issue:12',
      cause: 'part',
      partSlug: 'schema',
      summary: 'the migration never landed',
      detail: null,
      by: 'assessor',
      agentId: 'a3',
      taskId: 't3',
      decidedAt: '2026-07-30T10:00:00.000Z',
      updatedAt: '2026-07-30T10:00:00.000Z',
    },
  });
  assert.match(text, /the goal names a concrete table/);
  assert.match(text, /the widget ships behind a flag/);
  assert.match(text, /the migration never landed/);
  assert.match(text, /assessor/);
});

test('the files the goal has been edited in are carried, attributed and in the order given', () => {
  // The one section that is stored fields rather than stored prose. It is a join —
  // which agents worked this goal, and which of them wrote a path last — and never a
  // ranking: the order is the recency the store returned, a stored timestamp.
  const text = priorWorkBriefing({
    ...bare(),
    files: [
      file({ path: 'src/dispatcher/rules/issuePickup.ts', originRef: 'issue:12:part:pickup' }),
      file({ path: 'docs/spec/06-issue-pickup.md', createdAt: '2026-07-29T10:00:00.000Z' }),
    ],
  });
  assert.match(text, /src\/dispatcher\/rules\/issuePickup\.ts/);
  assert.match(text, /issue:12:part:pickup/, 'attributed to the work that wrote it, as the pad is');
  assert.match(text, /docs\/spec\/06-issue-pickup\.md/, 'a promoted doc is a place this goal has been written too');
  assert.ok(
    text.indexOf('issuePickup.ts') < text.indexOf('06-issue-pickup.md'),
    'most recently written first, as the store returned them',
  );
});

test('a part agent keeps the file list, because nothing else tells it where a sibling has been', () => {
  // `forPart` suppresses the parts section and nothing else: `siblingContext` renders
  // what a sibling was *for*, and renders nowhere at all where it has been.
  const files = [file()];
  assert.match(priorWorkBriefing({ ...bare(), files, forPart: true }), /src\/store\/schema\.ts/);
});

test('an over-long file list names what it dropped, the oldest first', () => {
  const files = Array.from({ length: 30 }, (_, i) =>
    file({ path: `src/file${i}.ts`, createdAt: `2026-07-30T${String(29 - i).padStart(2, '0')}:00:00.000Z` }),
  );
  const text = priorWorkBriefing({ ...bare(), files });
  assert.match(text, /src\/file0\.ts/, 'the most recent writes are the ones kept');
  assert.doesNotMatch(text, /src\/file29\.ts/, 'the oldest go first');
  assert.match(text, /5 of the 30 paths are not shown here/);
});

test('an over-long pad names what it dropped rather than truncating in silence', () => {
  // A partial record read as a whole one is the failure mode; the count and the
  // tool that reaches the rest are both stated.
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry({
      id: `scr_${i}`,
      note: `note number ${i}`,
      createdAt: `2026-07-30T${String(i).padStart(2, '0')}:00:00.000Z`,
    }),
  );
  const text = priorWorkBriefing({ ...bare(), entries });
  assert.match(text, /note number 19/, 'the most recent notes are the ones kept');
  assert.doesNotMatch(text, /note number 0\b/, 'the oldest go first');
  assert.match(text, /5 earlier notes/);
  assert.match(text, /scratch_read/, 'the rest is reachable, and the agent is told how');
});

// -- what actually reaches a dispatched agent --------------------------------

function systemFor(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-prior-'));
  return buildSystem(
    loadConfig({
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      repoRoot: gitRepo(),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/**
 * An agent that *has run* on `originRef` and wrote `paths`, as the file-events hook
 * records it. Finished, not queued: a live task on a goal's arm is a dispatch gate,
 * and this is history rather than work in flight.
 */
function agentThatWrote(store: Store, originRef: string, paths: string[], kind: 'code' | 'desk' = 'code'): void {
  const task = store.createTask({
    kind,
    title: `work on ${originRef}`,
    prompt: 'do it',
    branch: null,
    originRef,
    status: 'done',
  });
  const agent = store.createAgent({ taskId: task.id, cwd: '/tmp/wt', pid: null, status: 'done' });
  for (const path of paths) store.recordFile(agent.id, { path, tool: 'Edit', promoted: false });
}

test('the goal file join folds the whole subtree to one row per path, newest write first', () => {
  // A clock that moves on every write, so "which write was last" is a fact of the
  // data rather than of how fast the test ran.
  let tick = 0;
  const store = new Store(':memory:', () =>
    new Date(Date.parse('2026-07-30T00:00:00.000Z') + tick++ * 60_000).toISOString(),
  );
  try {
    agentThatWrote(store, 'issue:1:plan', ['src/a.ts']);
    agentThatWrote(store, 'issue:1:part:schema', ['src/a.ts', 'src/b.ts']);
    // Neither of these is this goal: another issue whose ref starts with this one's
    // (the subtree is `issue:1` or `issue:1:…`, never `issue:12`), and a desk agent
    // whose write-up lives in a scratch directory rather than in the repository.
    agentThatWrote(store, 'issue:12:part:other', ['src/elsewhere.ts']);
    agentThatWrote(store, 'issue:1:retro', ['write-up.md'], 'desk');

    const files = store.listGoalFiles('issue:1');
    assert.deepEqual(
      files.map((f) => f.path),
      ['src/b.ts', 'src/a.ts'],
      'one row per path, most recently written first, and no other goal or scratch directory in it',
    );
    assert.equal(
      files.find((f) => f.path === 'src/a.ts')?.originRef,
      'issue:1:part:schema',
      'a path written twice is dated and attributed by its last write',
    );
    assert.equal(store.listGoalFiles('issue:3').length, 0, 'a goal nobody has worked has nothing to say');
  } finally {
    store.close();
  }
});

test("a part's agent is handed what the earlier agents on its issue wrote down", async () => {
  const system = systemFor();
  try {
    // A one-part plan, which is where a goal delivered as one pull request now
    // goes: its part is dispatched by rule `plan-part`, and the briefing rides on
    // that dispatch exactly as it does on a stacked part's.
    const plan = planWithOnePart(system.store, 1, 'Ship the thing');
    system.store.upsertPlan({
      originRef: 'issue:1',
      title: 'Ship the thing',
      status: 'active',
      reason: 'One PR.',
      document: 'The registry is the only place that knows about the tag.',
    });
    assert.ok(plan);
    system.store.appendScratchEntry({
      padRef: 'issue:1',
      authorOriginRef: 'issue:1:plan',
      agentId: 'a_prior',
      taskId: 't_prior',
      topic: 'gotcha',
      note: 'the fake provider leaves labelsAddedByViewer unset',
    });
    agentThatWrote(system.store, 'issue:1:plan', ['src/tags/registry.ts']);
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    await system.harness.runCycle('manual');

    const task = system.store.listTasks().find((t) => t.originRef === 'issue:1:part:whole');
    assert.ok(task, "the plan's part was dispatched");
    assert.match(task.prompt, /Ship the thing/, 'the rendered template is still first');
    assert.match(task.prompt, /the registry is the only place/i, "the planner's write-up came with it");
    assert.match(task.prompt, /labelsAddedByViewer/, 'so did the pad');
    // The cheapest orientation there is: where the goal has already been edited,
    // which turns a grep phase into a Read.
    assert.match(task.prompt, /src\/tags\/registry\.ts/, 'and the files the earlier agent wrote');
  } finally {
    system.store.close();
  }
});

test('an agent on a different goal is handed none of it', async () => {
  // `padOriginFor`'s scoping, which is `outstandingForOrigin`'s widening rule at the
  // level of a whole goal: a planner's write-up about issue #1 is neither actionable
  // by a PR agent nor tellable apart from its own task.
  const system = systemFor();
  try {
    system.store.appendScratchEntry({
      padRef: 'issue:1',
      authorOriginRef: 'issue:1',
      agentId: 'a_prior',
      taskId: 't_prior',
      topic: null,
      note: 'a note about issue one',
    });
    system.connector.inject({ kind: 'new_pr', number: 7, title: 'Something else', branch: 'feature/x' });
    system.connector.inject({ kind: 'ci_failed', prNumber: 7 });
    await system.harness.runCycle('manual');

    const prTask = system.store.listTasks().find((t) => t.originRef?.startsWith('pr:7'));
    assert.ok(prTask, 'the CI concern dispatched');
    assert.doesNotMatch(prTask.prompt, /a note about issue one/);
  } finally {
    system.store.close();
  }
});
