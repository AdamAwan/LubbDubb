import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { watchDeclareNote } from '../src/plans/planning.js';
import type { Agent } from '../src/types.js';

/**
 * `watch_declare`: the working agent's half of the declaration, and the operator's
 * ruling on it.
 *
 * At the `buildSystem` seam with `dbPath: ':memory:'` and `FakeEnvironmentObserver`
 * injected. The assertions that earn their place are the silences — a declaration
 * that took effect without anybody accepting it would put an agent-authored query
 * on the operator's own telemetry with the operator's own credential, and nothing
 * about that is red.
 */

interface ToolResultText {
  isError?: boolean;
  content: { text?: string }[];
}

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};

const SIGNAL = {
  id: 'no-timeouts',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
};

const MEASURE = {
  id: 'orders-p95',
  title: 'The orders proc is no slower than it was',
  query: 'requests | summarize value = percentile(duration, 95)',
  expect: { noWorseThan: 'baseline' },
  unit: 'ms',
};

function build(observer: FakeEnvironmentObserver, environments: EnvironmentConfig[] = [TEST_UK]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-declare-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: observer,
    errorMirror: () => {},
  });
}

/** An agent doing the work, not planning it — the one party that knows what the code emits. */
function spawnWorker(system: System, originRef = 'issue:12'): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'fix it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Job X keeps timing out',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function declare(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('watch_declare', args)) as ToolResultText;
  const text = result.content[0]?.text ?? '{}';
  // A refusal comes back as prose rather than as a payload, which is what an
  // agent reads — so it is kept as prose here rather than parsed into nothing.
  return {
    isError: result.isError === true,
    text,
    payload: result.isError === true ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The plan-sheet slice: live checks and the ones waiting on a ruling, which is what the sheet draws. */
function sheet(system: System) {
  return [...system.store.listGoalWatches(), ...system.store.listProposedGoalWatches()];
}

test('a declaration is pending, and nothing is put to an environment until it is accepted', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const res = await declare(system, spawnWorker(system), {
    note: 'I added the retry-exhausted log line; this is what reads it.',
    signals: [SIGNAL],
  });

  assert.equal(res.isError, false);
  assert.deepEqual(res.payload['declared'], ['no-timeouts']);
  assert.equal(res.payload['pending'], true);
  // The whole authorisation story: the query runs inside the operator's own
  // command with the operator's own credential, so nothing has been asked.
  assert.deepEqual(observer.asked, [], 'an unapproved query is never put to an environment');
  assert.deepEqual(system.store.listGoalWatches(), [], 'and it is not live');
  const pending = system.store.listProposedGoalWatches();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.live, false);
  assert.match(pending[0]!.proposal!.note, /retry-exhausted/);
  system.store.close();
});

test('accepting makes it live and runs it once — which is where a measure gets its baseline', async () => {
  const observer = new FakeEnvironmentObserver({
    'orders-p95:measure': JSON.stringify([watchRow('orders-p95', { value: 8400 })]),
  });
  const system = build(observer);
  await declare(system, spawnWorker(system), { note: 'p95 is the number that would move.', measures: [MEASURE] });
  assert.equal(observer.asked.length, 0, 'a declaration nobody has ruled on is put to nothing');

  const ruled = system.store.ruleOnWatchProposal('issue:12', 'orders-p95', true);
  assert.ok(ruled);
  assert.equal(ruled!.live, true);
  assert.equal(ruled!.proposal, null);
  // The route runs the dry run in the same call; here it is the same seam.
  const refusals = await system.watch.run('issue:12');
  assert.deepEqual(refusals, []);
  const live = system.store.listGoalWatches();
  assert.equal(live.length, 1);
  assert.equal(live[0]!.baselineValue, 8400, 'the before the work has to beat, taken at declaration');
  assert.deepEqual(
    observer.asked.map((a) => a.kind),
    ['measure'],
  );
  system.store.close();
});

test('declining drops a declaration that was never anything but a proposal', async () => {
  const system = build(new FakeEnvironmentObserver());
  await declare(system, spawnWorker(system), { note: 'reads the new log line.', signals: [SIGNAL] });
  system.store.ruleOnWatchProposal('issue:12', 'no-timeouts', false);
  assert.deepEqual(sheet(system), [], 'nothing is left standing for a query nobody authorised');
  system.store.close();
});

test('it merges on the slug, and a live check is untouched until the amendment is accepted', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const agent = spawnWorker(system, 'issue:12:plan');
  // The planner's declaration, through the transport that speaks for the whole
  // block — then the working agent amending one check of it.
  const session = system.mcp.session(agent.id)!;
  await session.call('plan_submit', {
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix the proc', scope: 'src/db' }],
    watch: { signals: [{ ...SIGNAL, tolerate: 0 }] },
  });
  assert.equal(system.store.listGoalWatches()[0]!.dryRunRows, 1);

  const amended = { ...SIGNAL, query: "traces | where message has 'job X failed after retries'" };
  const res = await declare(system, spawnWorker(system), {
    note: 'The fix adds a retry, so timeouts do not stop — the honest signal is the failure after them.',
    signals: [amended],
  });
  assert.equal(res.isError, false);

  const live = system.store.listGoalWatches();
  assert.equal(live.length, 1, 'merged on the slug rather than filed beside it');
  assert.equal(live[0]!.query, SIGNAL.query, 'the live check is untouched while the amendment is pending');
  assert.equal(live[0]!.proposal!.declaration.query, amended.query);
  assert.equal(live[0]!.dryRunRows, 1, 'and its reading still stands, because nothing has changed yet');
  system.store.close();
});

test("an accepted amendment clears the reading it replaced, as a planner's amendment does", async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const planner = system.mcp.session(spawnWorker(system, 'issue:12:plan').id)!;
  await planner.call('plan_submit', {
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix the proc', scope: 'src/db' }],
    watch: { signals: [SIGNAL] },
  });
  // A reading taken inside a window, so there is something to be orphaned.
  system.store.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'clean',
    rows: 0,
    value: null,
    detail: null,
  });
  assert.equal(system.store.listWatchReadings().length, 1);

  await declare(system, spawnWorker(system), {
    note: 'The right question changed with the fix.',
    signals: [{ ...SIGNAL, query: "traces | where message has 'job X failed after retries'" }],
  });
  system.store.ruleOnWatchProposal('issue:12', 'no-timeouts', true);

  const live = system.store.listGoalWatches()[0]!;
  assert.match(live.query, /failed after retries/);
  assert.equal(live.dryRunVerdict, null, 'a reading is a reading of *that* query');
  assert.deepEqual(system.store.listWatchReadings(), [], 'and so is every reading the window took of it');
  system.store.close();
});

test('a planner is refused by name — it has a transport that declares the whole block', async () => {
  const system = build(new FakeEnvironmentObserver());
  const res = await declare(system, spawnWorker(system, 'issue:12:plan'), {
    note: 'x',
    signals: [SIGNAL],
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /yours to \*write\*/);
  system.store.close();
});

test('the declaration refuses exactly what a plan document refuses', async () => {
  const system = build(new FakeEnvironmentObserver());
  const agent = spawnWorker(system);
  // A signal without a presence query: it can never honestly report clean, so it
  // is a check that cannot fail.
  const noPresence = await declare(system, agent, { note: 'x', signals: [{ ...SIGNAL, presence: undefined }] });
  assert.equal(noPresence.isError, true);
  // A measure declaring neither a threshold nor a baseline: the same shape from
  // the other direction.
  const noExpectation = await declare(system, agent, { note: 'x', measures: [{ ...MEASURE, expect: {} }] });
  assert.equal(noExpectation.isError, true);
  // And a call that declared nothing at all, which would otherwise be a silent
  // success an agent could believe it had used.
  const nothing = await declare(system, agent, { note: 'x' });
  assert.equal(nothing.isError, true);
  assert.deepEqual(sheet(system), []);
  system.store.close();
});

test('the working agent’s watch note is appended, and names the tool it is about', () => {
  // Held back until the tool existed: an instruction naming a tool that is not
  // granted reads as a harness that lost one. Empty where nothing declares
  // telemetry, which is the off switch.
  assert.equal(watchDeclareNote([{ name: 'testUk' }]), '');
  const note = watchDeclareNote([TEST_UK]);
  assert.match(note, /watch_declare/);
  assert.match(note, /presence/);
  assert.match(note, /baseline/);
  assert.match(note, /until the operator accepts it/);
});
