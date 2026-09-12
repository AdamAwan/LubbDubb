import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';

class ParkedWorktrees extends FakeWorktreeManager {
  readonly reached: Promise<string>;
  private announce!: (branch: string) => void;
  private release!: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    super();
    this.reached = new Promise<string>((resolve) => {
      this.announce = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  override async ensure(branch: string, base?: string): Promise<string> {
    this.announce(branch);
    await this.gate;
    return super.ensure(branch, base);
  }

  letThrough(): void {
    this.release();
  }
}

class FailingWorktrees extends FakeWorktreeManager {
  override ensure(branch: string): Promise<string> {
    return Promise.reject(new Error(`EBUSY: resource busy or locked, rmdir '${branch}'`));
  }
}

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-readying-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 2,
  });
}

test('a dispatch waiting on the worktree pool is on the wire, as a row that is not an agent', async () => {
  const worktrees = new ParkedWorktrees();
  const system = buildSystem(testConfig(), { worktrees, backend: new FakePtyBackend() });

  const job = system.store.jobs.createJob({
    title: 'Remove the scan-check pollers',
    prompt: 'Remove them.',
    kind: 'code',
    branch: 'issue/35174/remove-scan-check-pollers',
  });

  const cycle = system.harness.runCycle('manual');
  await worktrees.reached;

  const waiting = buildStateSnapshot(system);
  assert.equal(waiting.readying.length, 1, 'the action being readied is on the wire');
  const row = waiting.readying[0]!;
  assert.equal(row.title, 'Remove the scan-check pollers');
  assert.equal(row.originRef, `job:${job.id}`);
  assert.equal(row.branch, 'issue/35174/remove-scan-check-pollers');
  assert.equal(row.step, 'slot-handover', 'and it says what it is waiting on');
  assert.ok(Date.parse(row.startedAt) > 0, 'with something to measure the wait from');

  assert.equal(waiting.agents.filter((a) => a.status !== 'done').length, 0, 'no agent row yet');
  assert.equal(system.store.agents.countLiveAgents(), 0, 'and nothing counted against the cap');

  worktrees.letThrough();
  await cycle;

  const after = buildStateSnapshot(system);
  assert.deepEqual(after.readying, [], 'the row leaves the moment the agent starts');
  assert.equal(after.agents.filter((a) => a.status !== 'done').length, 1, 'and the agent is what replaced it');

  system.store.close();
});

test('a dispatch that throws takes its readying row with it', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FailingWorktrees(), backend: new FakePtyBackend() });

  system.store.jobs.createJob({
    title: 'Remove the scan-check pollers',
    prompt: 'Remove them.',
    kind: 'code',
    branch: 'issue/35174/remove-scan-check-pollers',
  });
  await system.harness.runCycle('manual');

  assert.match(
    system.store.decisions.listDecisions().find((d) => d.outcome === 'rejected')!.detail,
    /Failed to start agent: EBUSY/,
  );
  assert.deepEqual(buildStateSnapshot(system).readying, []);

  system.store.close();
});

test('the board announces itself, so a cockpit sees the row without waiting for the pulse to end', async () => {
  const worktrees = new ParkedWorktrees();
  const system = buildSystem(testConfig(), { worktrees, backend: new FakePtyBackend() });

  const steps: string[] = [];
  system.readying.on('changed', () => steps.push(system.readying.list()[0]?.step ?? 'none'));

  system.store.jobs.createJob({ title: 'Look into it', prompt: 'Look into it.', kind: 'code', branch: 'issue/1/look' });
  const cycle = system.harness.runCycle('manual');
  await worktrees.reached;
  worktrees.letThrough();
  await cycle;

  assert.deepEqual(steps, ['picked-up', 'ci-evidence', 'slot-handover', 'none']);

  system.store.close();
});
