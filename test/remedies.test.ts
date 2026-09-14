import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent, Remedy, RemedyInput } from '../src/types.js';
import type { ReliabilityPayload } from '../src/wire.js';
import { remedyAskNote, remedyOrigin, validateRemedy } from '../src/remedies/remedies.js';
import { priorCiRemediesNote, priorReviewRemediesNote } from '../src/remedies/priorRemedies.js';
import { buildRemedyInsights } from '../src/insights/remedyInsights.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remedies-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function input(over: Partial<RemedyInput> = {}): RemedyInput {
  return {
    kind: 'ci',
    originRef: 'pr:12:ci',
    prNumber: 12,
    cause: 'missed_gate',
    guard: 'local_check',
    summary: 'format:check went red on line endings.',
    checks: ['format:check'],
    agentId: 'a_1',
    taskId: 't_1',
    ...over,
  };
}

test('the kind and the pull request come out of the origin, and every other caller is refused', () => {
  assert.deepEqual(remedyOrigin('pr:42:ci'), { ok: true, kind: 'ci', prNumber: 42, originRef: 'pr:42:ci' });
  assert.deepEqual(remedyOrigin('pr:42:comments'), {
    ok: true,
    kind: 'review',
    prNumber: 42,
    originRef: 'pr:42:comments',
  });
  for (const origin of ['issue:42', 'issue:42:retro', 'pr:42', 'pr:42:ci-gate', 'job:abc', null]) {
    const verdict = remedyOrigin(origin);
    assert.equal(verdict.ok, false, `${origin} must not resolve to a remedy scope`);
    if (!verdict.ok) assert.match(verdict.error, /conclude_work|retro_submit|report_finding/);
  }
});

test('a cause the kind cannot have is refused with the list it can', () => {
  const flakeOnReview = validateRemedy('review', { cause: 'flake', guard: 'documented', summary: 'x' });
  assert.equal(flakeOnReview.ok, false);
  if (!flakeOnReview.ok) assert.match(flakeOnReview.error, /convention/);

  const approachOnCi = validateRemedy('ci', { cause: 'approach', guard: 'documented', summary: 'x' });
  assert.equal(approachOnCi.ok, false);

  assert.equal(validateRemedy('ci', { cause: 'defect', guard: 'documented', summary: 'x' }).ok, true);
  assert.equal(validateRemedy('review', { cause: 'defect', guard: 'documented', summary: 'x' }).ok, true);
});

test('a bare pair of enums is not a reading', () => {
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'unpreventable' }).ok, false);
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'nonsense', summary: 'x' }).ok, false);
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'unpreventable', summary: '   ' }).ok, false);
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'unpreventable', summary: 'x'.repeat(401) }).ok, false);
});

test('a repeat of the same claim on the same task revises one row', () => {
  const { store } = build();
  const first = store.remedies.recordRemedy(input());
  const again = store.remedies.recordRemedy(input());
  assert.equal(again.id, first.id);
  assert.equal(store.remedies.listRemediesSince('2000-01-01T00:00:00.000Z').length, 1);
});

test('the same pull request coming back twice is two accounts, not one', () => {
  const { store } = build();
  store.remedies.recordRemedy(input({ taskId: 't_1' }));
  store.remedies.recordRemedy(input({ taskId: 't_2', summary: 'and again, on the same branch' }));
  assert.equal(store.remedies.listRemediesSince('2000-01-01T00:00:00.000Z').length, 2);
});

test('the recent read is scoped to a kind and capped in SQL', () => {
  const { store } = build();
  for (let i = 0; i < 5; i += 1) store.remedies.recordRemedy(input({ taskId: `t_${i}`, summary: `ci ${i}` }));
  store.remedies.recordRemedy(
    input({ kind: 'review', originRef: 'pr:12:comments', taskId: 't_r', summary: 'review', checks: [] }),
  );
  assert.equal(store.remedies.listRecentRemedies('ci', 3).length, 3);
  assert.equal(store.remedies.listRecentRemedies('review', 10).length, 1);
});

test('an empty record is an empty block, so every prompt is byte-identical to a build without this', () => {
  assert.equal(priorCiRemediesNote([], ['test']), '');
  assert.equal(priorReviewRemediesNote([]), '');
  const remedy: Remedy = {
    ...input(),
    id: 'r1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(priorCiRemediesNote([remedy], ['test']), '');
  assert.equal(priorCiRemediesNote([remedy], []), '');
  assert.match(priorCiRemediesNote([remedy], ['format:check']), /line endings/);
});

test('the block is evidence rather than instruction, and names what it dropped', () => {
  const many: Remedy[] = Array.from({ length: 9 }, (_, i) => ({
    ...input({ summary: `account number ${i} about a red on this check` }),
    id: `r${i}`,
    createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
  }));
  const note = priorCiRemediesNote(many, ['format:check']);
  assert.match(note, /evidence, not instruction/);
  assert.match(note, /authority/);
  assert.ok(note.indexOf('account number 8') < note.indexOf('account number 7'));
  assert.match(note, /further accounts on this record are not shown/);
});

test('the ask rides on every dispatch, record or no record', () => {
  for (const kind of ['ci', 'review'] as const) assert.match(remedyAskNote(kind), /report_remedy/);
});

test('cost is the filing agent’s spend, divided where it filed more than one', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const remedies: Remedy[] = [
    { ...input({ taskId: 't_1', summary: 'one' }), id: 'r1', createdAt: at, updatedAt: at },
    {
      ...input({ taskId: 't_1', summary: 'two', cause: 'flake', guard: 'unpreventable' }),
      id: 'r2',
      createdAt: at,
      updatedAt: at,
    },
  ];
  const insights = buildRemedyInsights({
    remedies,
    returnDispatches: ['t_1', 't_2', 't_3'],
    usageEvents: [{ agentId: 'a_1', costUsd: 10, at }],
  });
  assert.equal(insights.accounts, 2);
  assert.equal(insights.costUsd, 10);
  const guards = Object.fromEntries(insights.byGuard.map((g) => [g.guard, g.costUsd]));
  assert.equal(guards.local_check, 5);
  assert.equal(guards.unpreventable, 5);
  assert.equal(insights.unaccounted, 2);
});

test('a cause the fortnight never saw still draws, and the top check is named', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const remedies: Remedy[] = [
    { ...input({ taskId: 't_1', checks: ['format:check', 'lint'] }), id: 'r1', createdAt: at, updatedAt: at },
    { ...input({ taskId: 't_2', summary: 'again', checks: ['format:check'] }), id: 'r2', createdAt: at, updatedAt: at },
  ];
  const insights = buildRemedyInsights({ remedies, returnDispatches: ['t_1', 't_2'], usageEvents: [] });
  const ci = insights.byKind.find((k) => k.kind === 'ci');
  assert.ok(ci);
  assert.ok(ci.byCause.some((c) => c.cause === 'flake' && c.accounts === 0));
  const gate = ci.byCause.find((c) => c.cause === 'missed_gate');
  assert.deepEqual(gate?.topCheck, { name: 'format:check', accounts: 2 });
  assert.equal(insights.byKind.find((k) => k.kind === 'review')?.accounts, 0);
});

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'pr/12',
    originRef,
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('a remedy records the return and files nothing beside it', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:12:ci');
  const res = await callTool(system, agent, 'report_remedy', {
    cause: 'missed_gate',
    guard: 'undocumented',
    summary: 'check went red on an exported type nothing imports.',
    claim: 'knip runs every rule at error.',
  });
  assert.equal(res.isError, false);
  assert.equal(system.store.remedies.listRemediesSince('2000-01-01T00:00:00.000Z').length, 1);
  assert.deepEqual(system.store.obstacles.listObstacles(), [], 'the one door is `raise`, and this is not it');
  system.store.close();
});

test('the Causes reading rides on the panel it is a section of', async () => {
  const system = build();
  system.store.remedies.recordRemedy(input());
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/reliability' });
  assert.equal(res.statusCode, 200);
  const payload = res.json() as ReliabilityPayload;
  assert.equal(payload.remedies.accounts, 1);
  assert.equal(payload.remedies.byKind.find((k) => k.kind === 'ci')?.accounts, 1);
  assert.ok(payload.insights.window.buckets > 0);
  await app.close();
});

test('an account filed in the window by an older dispatch accounts for that dispatch alone', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const remedies: Remedy[] = [
    { ...input({ taskId: 't_older', summary: 'from before the window' }), id: 'r1', createdAt: at, updatedAt: at },
  ];
  const insights = buildRemedyInsights({
    remedies,
    returnDispatches: ['t_1', 't_2', 't_3', 't_4', 't_5'],
    usageEvents: [],
  });
  assert.equal(insights.accounts, 1, 'the account is in the window and counts as one');
  assert.equal(insights.unaccounted, 5, 'and every in-window dispatch that filed nothing is still unaccounted');
});
