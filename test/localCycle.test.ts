import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { WorldSnapshot } from '../src/types.js';

/**
 * The **local** cycle: the full decide/execute sequence against the world the last
 * real cycle already read, with every world-facing pass skipped.
 *
 * What these hold is the property the whole thing rests on — it reads no world — and
 * the reason it exists: an agent ending refills its own slot in a moment rather than
 * at the next heartbeat. → `docs/spec/04-harness-cycle.md#the-local-cycle`
 */

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    // Long enough that nothing here is ever the timer's doing: every cycle in this
    // file is one somebody asked for.
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

/**
 * A system whose worktrees are faked — mandatory for anything that dispatches a code
 * agent, or the test cuts a real branch in the checkout the suite is running in.
 */
function build(overrides: Partial<Config> = {}): { system: System; backend: FakePtyBackend } {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend,
    errorMirror: () => {},
  });
  return { system, backend };
}

/** Count the provider fan-outs, by standing in front of the connector's own read. */
function countWorldReads(system: System): () => number {
  let reads = 0;
  const connector = system.connector as { getState: () => Promise<WorldSnapshot> };
  const original = connector.getState.bind(system.connector);
  connector.getState = async (): Promise<WorldSnapshot> => {
    reads += 1;
    return original();
  };
  return () => reads;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return;
    await tick(10);
  }
}

test('a local cycle before any real one refuses rather than deciding against an empty world', async () => {
  const { system } = build();
  const reads = countWorldReads(system);

  const report = await system.harness.runCycle('local');

  assert.equal(report.cycleId, 'unbaselined');
  assert.equal(report.readWorld, false);
  assert.match(report.rationale, /no world baseline/);
  assert.equal(reads(), 0, 'a refusal must not reach for the world either');
  system.store.close();
});

test('a local cycle takes no snapshot and still dispatches from store state', async () => {
  // Paused, so the first (real) cycle reads the world and plans nothing: the issue
  // is left queued with its baseline already taken.
  const { system } = build();
  system.runtimeControl.apply({ paused: true });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.listTasks().length, 0, 'nothing is dispatched while paused');

  const reads = countWorldReads(system);
  system.runtimeControl.apply({ paused: false });
  const report = await system.harness.runCycle('local');

  assert.equal(reads(), 0, 'a local cycle must not call the connector at all');
  assert.equal(report.readWorld, false, 'and must say so on the report');
  assert.equal(report.source, 'local');
  assert.ok(report.cycleId.startsWith('cyc_'), 'it is a real cycle, with a real id and an audit row');
  assert.equal(system.store.listTasks().length, 1, 'the issue in the cached world is dispatched');
  const rationale = system.store
    .listDecisions(50)
    .find((d) => d.cycleId === report.cycleId && d.action.type === 'no_op');
  assert.ok(rationale, 'the rationale is audited, exactly as a real cycle audits its own');
  assert.match(rationale!.detail ?? '', /^\[local\]/, 'and names the source, so the row says which world it read');
  system.store.close();
});

test('a local cycle is refused while a real cycle is in flight', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Second issue' });
  await system.harness.runCycle('manual');

  // Hold the real cycle open inside its world read, which is the window a route's
  // manual pulse and an agent's ending both land in on a busy fleet.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const connector = system.connector as { getState: () => Promise<WorldSnapshot> };
  const original = connector.getState.bind(system.connector);
  connector.getState = async (): Promise<WorldSnapshot> => {
    await gate;
    return original();
  };
  const inFlight = system.harness.runCycle('timer');
  await tick(20);

  const local = await system.harness.runCycle('local');
  assert.equal(local.cycleId, 'coalesced');
  assert.equal(local.readWorld, false);

  release();
  await inFlight;
  system.store.close();
});

test('a local cycle is held while a crashed agent awaits a recovery decision', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_issue', number: 903, title: 'Add logout' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.listTasks().length, 1);
  // What a restart finds: a row saying `running` with no process behind it.
  system.recovery.detect();
  assert.ok(system.recovery.pendingCount() > 0);

  const reads = countWorldReads(system);
  const report = await system.harness.runCycle('local');

  assert.equal(report.cycleId, 'held', 'the hold is asked before anything else, local or not');
  assert.match(report.rationale, /await a recovery decision/);
  assert.equal(reads(), 0);
  system.store.close();
});

test('an agent finishing fires a local cycle, and the slot it freed is filled', async () => {
  // A cap of one, so the second issue is queued behind the first agent and the only
  // thing that can start it is capacity coming back.
  const { system } = build({ maxConcurrentAgents: 1 });
  const sources: string[] = [];
  system.harness.on('cycle:end', (r) => sources.push(r.source));
  system.connector.inject({ kind: 'new_issue', number: 904, title: 'Add login' });
  system.connector.inject({ kind: 'new_issue', number: 905, title: 'Add logout' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.listTasks().length, 1, 'the cap admits one');

  const reads = countWorldReads(system);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  assert.equal(system.agents.complete(agent.id), true);

  await waitFor(() => system.store.listTasks().length > 1);
  assert.equal(system.store.listTasks().length, 2, 'the freed slot is refilled without waiting for a heartbeat');
  assert.ok(sources.includes('local'), `the refill came from a local cycle, not a timer (saw ${sources.join(', ')})`);
  assert.equal(reads(), 0, 'and it cost no provider traffic');
  system.localCycles.stop();
  system.store.close();
});

test('a burst of endings is one cycle, not one each', async () => {
  const { system } = build({ maxConcurrentAgents: 3 });
  const locals: string[] = [];
  system.harness.on('cycle:end', (r) => {
    if (r.source === 'local') locals.push(r.cycleId);
  });
  system.connector.inject({ kind: 'new_issue', number: 906, title: 'One' });
  system.connector.inject({ kind: 'new_issue', number: 907, title: 'Two' });
  system.connector.inject({ kind: 'new_issue', number: 908, title: 'Three' });
  await system.harness.runCycle('manual');
  const agents = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(agents.length, 3, 'three agents, so three endings arrive together');

  for (const a of agents) system.agents.complete(a.id);
  await waitFor(() => locals.length > 0);
  await tick(400);

  assert.equal(locals.length, 1, `three endings must debounce into one cycle (saw ${locals.length})`);
  system.localCycles.stop();
  system.store.close();
});
