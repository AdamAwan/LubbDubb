import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { WatchSchema } from '../src/validation/watchDocument.js';
import { watchNote } from '../src/plans/planning.js';
import type { Agent } from '../src/types.js';

/** What a tool call comes back as, on the wire the agent's bridge reads. */
interface ToolResultText {
  isError?: boolean;
  content: { text?: string }[];
}

/**
 * The declaration, the dry run, and the refusals it hands back — at the
 * `buildSystem` seam with `dbPath: ':memory:'` and `FakeEnvironmentObserver`
 * injected. Nothing here spawns a shell or touches a network.
 */

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk', schema: 'Structured logs land in `traces`.' },
};

/** One signal, declared as a planner would. */
const SIGNAL = {
  id: 'no-timeouts',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
  tolerate: 0,
};

function build(observer: FakeEnvironmentObserver, environments: EnvironmentConfig[] = [TEST_UK]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-'));
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

function spawnPlanner(system: System): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Plan issue #12',
    prompt: 'plan it',
    branch: 'issue/12/plan',
    originRef: 'issue:12:plan',
    originTitle: 'Job X keeps timing out',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function submit(system: System, agent: Agent, watch: unknown) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('plan_submit', {
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix the proc', scope: 'src/db' }],
    watch,
  })) as ToolResultText;
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
  };
}

test('a signal whose presence query answers zero is unknown, not clean', async () => {
  // The commonest real case, and the one that reads as success: an acceptance
  // environment where the scheduled job does not run. Everything answers zero.
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': '[]',
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  assert.equal(res.isError, false);

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunPresence, 'zero');
  assert.equal(check.dryRunVerdict, 'unknown', 'zero presence is unknown, never a clean reading');
  assert.match(check.dryRunDetail!, /never heard of this code path/);
  // And the check's own query is not even asked: whatever it would say about a
  // defect inside a code path the telemetry does not know is not a reading.
  assert.deepEqual(
    observer.asked.map((a) => a.kind),
    ['presence'],
  );
  system.store.close();
});

test('a dry run that cannot resolve is returned to the author, not swallowed', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': '[]',
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  // The plan is kept — a refusal about one query is not a reason to lose a
  // decomposition — and the reason comes back in the same turn, where it is cheap.
  assert.ok(system.store.getPlanByOrigin('issue:12'), 'the plan landed');
  const refusals = res.payload['watchDryRun'] as string[];
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!, /^no-timeouts: /);
  system.store.close();
});

test('a result that omits the id echo is unknown, not clean', async () => {
  // A stale wrapper script: it ran something, and it was not the query it was
  // given. Read as an answer, it is a verdict about a different question.
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([{ role: 'worker' }]),
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.match(check.dryRunDetail!, /without the query it was given/);
  assert.equal((res.payload['watchDryRun'] as string[]).length, 1);
  system.store.close();
});

test('an observation that answers nothing at all is unknown', async () => {
  // Nothing scripted: the fake answers "could not say", which is what an expired
  // credential and a missing binary both look like. Never folded into zero.
  const system = build(new FakeEnvironmentObserver());
  await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.match(check.dryRunDetail!, /could not read testUk/);
  system.store.close();
});

test('presence firing and the signal firing is the reading with nothing to hand back', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker' }), watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunPresence, 'fires');
  assert.equal(check.dryRunVerdict, 'fires');
  assert.equal(check.dryRunRows, 2);
  assert.equal(check.dryRunDetail, null, 'the query is live and the reported defect is real — nothing to fix');
  assert.equal(check.dryRunEnvironment, 'testUk');
  assert.equal(res.payload['watchDryRun'], undefined);
  system.store.close();
});

test('a firing presence over a silent signal is handed back — the query is wrong or the ticket is', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunVerdict, 'zero');
  assert.equal(check.dryRunRows, 0);
  assert.match(check.dryRunDetail!, /Either the query is wrong or the ticket is/);
  assert.equal((res.payload['watchDryRun'] as string[]).length, 1);
  system.store.close();
});

test('a goal that declares no watch reads null and asks nothing', async () => {
  const observer = new FakeEnvironmentObserver();
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), undefined);
  assert.equal(res.isError, false);
  assert.deepEqual(system.store.listGoalWatches(), []);
  assert.deepEqual(observer.asked, [], 'nothing is asked about a goal with nothing to watch');
  system.store.close();
});

test('no environment declares telemetry, so nothing is asked and nothing is refused', async () => {
  const observer = new FakeEnvironmentObserver();
  const system = build(observer, [{ name: 'testUk', at: 'echo unused' }]);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  // Declared and drawn, with no reading: the feature is off, not broken.
  assert.equal(system.store.listGoalWatches().length, 1);
  assert.equal(system.store.listGoalWatches()[0]!.dryRunVerdict, null);
  assert.deepEqual(observer.asked, []);
  assert.equal(res.payload['watchDryRun'], undefined);
  system.store.close();
});

test('an amendment merges on the id and clears the reading it replaced', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const agent = spawnPlanner(system);
  await submit(system, agent, { signals: [SIGNAL] });
  assert.equal(system.store.listGoalWatches()[0]!.dryRunRows, 1);

  // The same id, a different query. The reading is a reading of *that* query, so
  // the amendment must re-ask rather than leave the old answer standing under the
  // new text — which is what the ingest's cleared columns and the re-run buy.
  await submit(system, agent, { signals: [{ ...SIGNAL, id: 'no-timeouts', query: 'traces | where 1 == 2' }] });
  const rows = system.store.listGoalWatches();
  assert.equal(rows.length, 1, 'merged on the id rather than filed beside it');
  assert.equal(rows[0]!.query, 'traces | where 1 == 2');
  assert.deepEqual(
    observer.asked.filter((a) => a.kind === 'signal').map((a) => a.query),
    [SIGNAL.query, 'traces | where 1 == 2'],
    'the amended query was put to the environment, not assumed to answer as its predecessor did',
  );
  system.store.close();
});

test('a check an amendment stopped declaring stops being asked about', async () => {
  const system = build(new FakeEnvironmentObserver());
  const agent = spawnPlanner(system);
  await submit(system, agent, { signals: [SIGNAL, { ...SIGNAL, id: 'no-retries' }] });
  assert.equal(system.store.listGoalWatches().length, 2);
  await submit(system, agent, { signals: [SIGNAL] });
  assert.deepEqual(
    system.store.listGoalWatches().map((w) => w.id),
    ['no-timeouts'],
  );
  system.store.close();
});

// --- the declaration's own refusals ----------------------------------------

test('a signal without a presence query is refused', () => {
  const parsed = WatchSchema.safeParse({ signals: [{ ...SIGNAL, presence: undefined }] });
  assert.equal(parsed.success, false);
});

test('a watch block declares only signals, and duplicate ids are refused', () => {
  assert.equal(WatchSchema.safeParse({ signals: [], measures: [] }).success, false);
  assert.equal(WatchSchema.safeParse({ signals: [SIGNAL, SIGNAL] }).success, false);
  assert.equal(WatchSchema.safeParse({ signals: [SIGNAL] }).success, true);
  // `tolerate` defaults to zero — the thing should not be happening at all.
  const parsed = WatchSchema.parse({ signals: [{ ...SIGNAL, tolerate: undefined }] });
  assert.equal(parsed.signals[0]!.tolerate, 0);
});

test('an id that is not kebab-case is refused, because it is interpolated into the projection', () => {
  assert.equal(WatchSchema.safeParse({ signals: [{ ...SIGNAL, id: 'no"; drop table --' }] }).success, false);
});

// --- the environment config's own refusals ---------------------------------

test('validateEnvironments refuses a watch that cannot mean what it says', () => {
  const refuse = (watch: unknown, why: RegExp) =>
    assert.throws(() => validateEnvironments([{ name: 'testUk', at: 'x', watch } as EnvironmentConfig]), why);
  refuse({ observe: '  ' }, /unanswerable forever/);
  refuse({ observe: 'x', holds: ['deploy'] }, /not an obligation the harness files/);
  refuse({ observe: 'x', forMs: 0 }, /positive number of milliseconds/);
  // A `describe` without an `observe` is a schema for a question nothing asks.
  assert.throws(
    () => validateEnvironments([{ name: 'testUk', at: 'x', describe: 'y' } as unknown as EnvironmentConfig]),
    /belongs inside "watch"/,
  );
  assert.doesNotThrow(() => validateEnvironments([TEST_UK]));
});

// --- the prompt, and the lens boundary -------------------------------------

test('the planner’s watch guidance is appended, and is empty where nothing declares telemetry', () => {
  assert.equal(watchNote([{ name: 'testUk' }]), '');
  const note = watchNote([TEST_UK]);
  assert.match(note, /testUk/);
  assert.match(note, /presence/);
  // The operator's own schema prose rides along — appended, so an override that
  // never learned a `{watch}` token cannot drop it.
  assert.match(note, /Structured logs land in/);
});

test('nothing under src/dispatcher/ imports src/environments/', () => {
  // Structural, the way the other lens boundaries are kept. `src/environments/` is
  // a read-only view: a rule consulting one would be a second opinion about a
  // decision made elsewhere, and a watch could then spend an agent by accident.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && /from '[^']*environments\//.test(readFileSync(path, 'utf8')))
        offenders.push(path);
    }
  };
  walk('src/dispatcher');
  assert.deepEqual(offenders, []);
});
