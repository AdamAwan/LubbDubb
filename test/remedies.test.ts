import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent, Remedy, RemedyInput } from '../src/types.js';
import type { ReliabilityPayload } from '../src/wire.js';
import { remedyAskNote, remedyOrigin, validateRemedy } from '../src/remedies/remedies.js';
import { priorCiRemediesNote, priorReviewRemediesNote } from '../src/remedies/priorRemedies.js';
import { buildRemedyInsights } from '../src/remedyInsights.js';

/**
 * Remedies: why the fleet came back to a pull request, and what settled it.
 *
 * The feature is one write and two readers, and the assertions divide the same
 * way. What most of them are about is the pair of properties that make the counts
 * worth anything at all:
 *
 * - **The kind, the pull request and the checks are never claimed.** They come
 *   out of the caller's own task, so a column here reports one thing rather than
 *   whatever each agent took the field to mean.
 * - **Nothing gates on a remedy.** No rule reads the table, the prompt block is
 *   empty when the record is, and an agent that files nothing costs the account
 *   and nothing else.
 */

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

// -- the fence ----------------------------------------------------------------

test('the kind and the pull request come out of the origin, and every other caller is refused', () => {
  assert.deepEqual(remedyOrigin('pr:42:ci'), { ok: true, kind: 'ci', prNumber: 42, originRef: 'pr:42:ci' });
  assert.deepEqual(remedyOrigin('pr:42:comments'), {
    ok: true,
    kind: 'review',
    prNumber: 42,
    originRef: 'pr:42:comments',
  });
  // Refused by name and pointed at the tool it actually wants — the shape every
  // other origin fence in the channel uses, because "not allowed" with no
  // alternative is an agent that retries.
  for (const origin of ['issue:42', 'issue:42:retro', 'pr:42', 'pr:42:ci-gate', 'job:abc', null]) {
    const verdict = remedyOrigin(origin);
    assert.equal(verdict.ok, false, `${origin} must not resolve to a remedy scope`);
    if (!verdict.ok) assert.match(verdict.error, /conclude_work|retro_submit|report_finding/);
  }
});

// -- what a submission may be -------------------------------------------------

test('a cause the kind cannot have is refused with the list it can', () => {
  // A review round is never a flake and a red check is never a matter of taste.
  // The refusal names the whole allowed list, because the agent's next move is to
  // pick from it.
  const flakeOnReview = validateRemedy('review', { cause: 'flake', guard: 'documented', summary: 'x' });
  assert.equal(flakeOnReview.ok, false);
  if (!flakeOnReview.ok) assert.match(flakeOnReview.error, /convention/);

  const approachOnCi = validateRemedy('ci', { cause: 'approach', guard: 'documented', summary: 'x' });
  assert.equal(approachOnCi.ok, false);

  // `defect` is deliberately in both, under one name: a bug the suite caught and
  // a bug a reviewer caught are the same fact about the fleet.
  assert.equal(validateRemedy('ci', { cause: 'defect', guard: 'documented', summary: 'x' }).ok, true);
  assert.equal(validateRemedy('review', { cause: 'defect', guard: 'documented', summary: 'x' }).ok, true);
});

test('a bare pair of enums is not a reading', () => {
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'unpreventable' }).ok, false);
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'nonsense', summary: 'x' }).ok, false);
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'unpreventable', summary: '   ' }).ok, false);
  assert.equal(validateRemedy('ci', { cause: 'flake', guard: 'unpreventable', summary: 'x'.repeat(401) }).ok, false);
});

// -- the store ----------------------------------------------------------------

test('a repeat of the same claim on the same task revises one row', () => {
  const { store } = build();
  const first = store.recordRemedy(input());
  const again = store.recordRemedy(input());
  assert.equal(again.id, first.id);
  assert.equal(store.listRemediesSince('2000-01-01T00:00:00.000Z').length, 1);
});

test('the same pull request coming back twice is two accounts, not one', () => {
  // The repetition is the strongest signal the table holds — keying on the origin
  // would hide exactly the pull request an operator most needs to see.
  const { store } = build();
  store.recordRemedy(input({ taskId: 't_1' }));
  store.recordRemedy(input({ taskId: 't_2', summary: 'and again, on the same branch' }));
  assert.equal(store.listRemediesSince('2000-01-01T00:00:00.000Z').length, 2);
});

test('the recent read is scoped to a kind and capped in SQL', () => {
  const { store } = build();
  for (let i = 0; i < 5; i += 1) store.recordRemedy(input({ taskId: `t_${i}`, summary: `ci ${i}` }));
  store.recordRemedy(
    input({ kind: 'review', originRef: 'pr:12:comments', taskId: 't_r', summary: 'review', checks: [] }),
  );
  assert.equal(store.listRecentRemedies('ci', 3).length, 3);
  assert.equal(store.listRecentRemedies('review', 10).length, 1);
});

// -- the prompt block ---------------------------------------------------------

test('an empty record is an empty block, so every prompt is byte-identical to a build without this', () => {
  assert.equal(priorCiRemediesNote([], ['test']), '');
  assert.equal(priorReviewRemediesNote([]), '');
  // A record that says nothing about *these* checks is also nothing: an account
  // of `knip` is noise on a dispatch about `test`.
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
  // The framing the knowledge block uses, for its reason: a block of assertions an
  // agent reads as orders makes every agent worse the moment one goes stale.
  assert.match(note, /evidence, not instruction/);
  assert.match(note, /authority/);
  // Newest first, and what the cap left out is said rather than silently cut.
  assert.ok(note.indexOf('account number 8') < note.indexOf('account number 7'));
  assert.match(note, /further accounts on this record are not shown/);
});

test('the ask rides on every dispatch, record or no record', () => {
  // Appended unconditionally, unlike the record block: the account is the thing
  // being asked for, so a fleet with nothing recorded is the fleet that most
  // needs the ask. `report_remedy` is named here because it is named nowhere in
  // the protocol addendum (see test/mcpChannel.test.ts).
  for (const kind of ['ci', 'review'] as const) assert.match(remedyAskNote(kind), /report_remedy/);
});

// -- the fold -----------------------------------------------------------------

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
  // One dispatch filed two accounts, so the honesty figure counts *dispatches*
  // and never goes negative.
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
  // "Nothing was a flake this fortnight" is a reading, and a table that dropped
  // its own zero rows could not make it.
  assert.ok(ci.byCause.some((c) => c.cause === 'flake' && c.accounts === 0));
  const gate = ci.byCause.find((c) => c.cause === 'missed_gate');
  assert.deepEqual(gate?.topCheck, { name: 'format:check', accounts: 2 });
  // A review remedy has no checks, so it has no top check to name.
  assert.equal(insights.byKind.find((k) => k.kind === 'review')?.accounts, 0);
});

// -- the tool, and the claim it raises ----------------------------------------

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
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

/**
 * The remedy is the **event record and nothing else**. What a round taught that
 * outlives the pull request goes through `raise`, on the board that keys and
 * counts it — one door, rather than the same sentence reaching two stores under
 * two gates depending on which tool the agent happened to be holding.
 */
test('a remedy records the return and files nothing beside it', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:12:ci');
  const res = await callTool(system, agent, 'report_remedy', {
    cause: 'missed_gate',
    guard: 'undocumented',
    summary: 'check went red on an exported type nothing imports.',
    // The field the claim store's arm used to carry. It is not in the schema any
    // more, and an argument the schema does not name is simply not read.
    claim: 'knip runs every rule at error.',
  });
  assert.equal(res.isError, false);
  assert.equal(system.store.listRemediesSince('2000-01-01T00:00:00.000Z').length, 1);
  assert.deepEqual(system.store.listObstacles(), [], 'the one door is `raise`, and this is not it');
  system.store.close();
});

// -- the route ----------------------------------------------------------------

test('the Causes reading rides on the panel it is a section of', async () => {
  const system = build();
  system.store.recordRemedy(input());
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/reliability' });
  assert.equal(res.statusCode, 200);
  const payload = res.json() as ReliabilityPayload;
  // One fetch, one window: two routes for one modal would be two chances for the
  // two halves to describe different fortnights.
  assert.equal(payload.remedies.accounts, 1);
  assert.equal(payload.remedies.byKind.find((k) => k.kind === 'ci')?.accounts, 1);
  assert.ok(payload.insights.window.buckets > 0);
  await app.close();
});

// #543 — the two populations are windowed on different dates, so `unaccounted`
// has to be counted by membership. Subtracting counts let a straddling dispatch
// cancel a genuinely unaccounted one, in the direction that flatters the fleet.
test('an account filed in the window by an older dispatch accounts for that dispatch alone', () => {
  const at = '2026-01-01T00:00:00.000Z';
  // Five in-window dispatches, none of which filed anything, plus one account
  // filed inside the window by a dispatch made before it.
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
