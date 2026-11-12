import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { createPrepare } from '../src/store/context.js';
import { RUNTIME_THRESHOLDS, RuntimeHealthWatch, SlowReadTally, type LoopDelaySampler } from '../src/runtimeHealth.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import type { ErrorLogInput } from '../src/types.js';
import type { HealthPayload } from '../src/wire.js';

const MS = 1e6;

class FakeSampler implements LoopDelaySampler {
  samplesNs: number[] = [];
  enabled = false;
  enable(): boolean {
    this.enabled = true;
    return true;
  }
  disable(): boolean {
    this.enabled = false;
    return true;
  }
  reset(): void {
    this.samplesNs = [];
  }
  percentile(p: number): number {
    const sorted = [...this.samplesNs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  }
  get mean(): number {
    return this.samplesNs.reduce((a, b) => a + b, 0) / Math.max(1, this.samplesNs.length);
  }
  get max(): number {
    return Math.max(0, ...this.samplesNs);
  }
  delays(...ms: number[]): void {
    this.samplesNs.push(...ms.map((m) => m * MS));
  }
}

function capture(): ErrorRecorder & { entries: ErrorLogInput[] } {
  const entries: ErrorLogInput[] = [];
  return {
    entries,
    record(input) {
      entries.push(input);
      return { id: String(entries.length), createdAt: '', ...input, detail: input.detail ?? null };
    },
  };
}

function watch(clock: { at: number }) {
  const sampler = new FakeSampler();
  const errors = capture();
  const reads = new SlowReadTally(() => 0);
  const health = new RuntimeHealthWatch({ errors, reads, sampler, clock: () => clock.at });
  return { sampler, errors, reads, health };
}

test('a quiet window is read and recorded nowhere', () => {
  const clock = { at: Date.parse('2026-11-12T10:00:00Z') };
  const { sampler, errors, health } = watch(clock);
  assert.equal(health.reading().eventLoop, null, 'nothing to say before the first window closes');
  sampler.delays(20, 21, 22, 40);
  health.tick();
  assert.deepEqual(errors.entries, []);
  assert.equal(health.reading().eventLoop?.maxMs, 40);
  assert.deepEqual(sampler.samplesNs, [], 'each window starts empty');
});

test('one long stall is red even when the p99 is fine', () => {
  const clock = { at: Date.parse('2026-11-12T10:00:00Z') };
  const { sampler, errors, health } = watch(clock);
  sampler.delays(...Array.from({ length: 999 }, () => 20), 22_000);
  health.tick();
  assert.equal(errors.entries.length, 1);
  assert.equal(errors.entries[0]?.source, 'runtime');
  assert.match(errors.entries[0]?.message ?? '', /longest stall 22,000 ms/);
  assert.equal(health.reading().eventLoop?.maxMs, 22_000);
});

test('a sustained high p99 is red without any single long stall', () => {
  const clock = { at: Date.parse('2026-11-12T10:00:00Z') };
  const { sampler, errors, health } = watch(clock);
  sampler.delays(...Array.from({ length: 100 }, () => 1_500));
  health.tick();
  assert.equal(errors.entries.length, 1);
});

test('a lag that persists is one entry per quiet period, carrying what it held back', () => {
  const clock = { at: Date.parse('2026-11-12T10:00:00Z') };
  const { sampler, errors, health } = watch(clock);
  for (let i = 0; i < 4; i++) {
    sampler.delays(6_000);
    health.tick();
    clock.at += RUNTIME_THRESHOLDS.windowMs;
  }
  assert.equal(errors.entries.length, 1, 'a stuck loop does not write a row every window');
  clock.at += RUNTIME_THRESHOLDS.quietMs;
  sampler.delays(6_000);
  health.tick();
  assert.equal(errors.entries.length, 2);
  assert.match(errors.entries[1]?.detail ?? '', /3 more blocked windows since the last entry/);
});

test('a slow store read is named by its whole statement, grouped per statement', () => {
  const db = new Database(':memory:');
  try {
    let t = 0;
    const reads = new SlowReadTally(() => (t += 300));
    const prep = createPrepare(db, reads);
    const errors = capture();
    const clock = { at: Date.parse('2026-11-12T10:00:00Z') };
    const health = new RuntimeHealthWatch({ errors, reads, sampler: new FakeSampler(), clock: () => clock.at });

    const slow = `\n  SELECT 1 AS one\n  WHERE 1 = 1`;
    assert.deepEqual(prep(slow).get(), { one: 1 }, 'a timed statement still answers');
    assert.deepEqual(prep(slow).pluck().all(), [1], 'and still answers through its modes');
    health.tick();

    assert.equal(errors.entries.length, 1, 'two slow reads of one statement are one entry');
    assert.match(errors.entries[0]?.message ?? '', /a store read took 300 ms: SELECT 1 AS one WHERE 1 = 1$/);
    assert.match(errors.entries[0]?.detail ?? '', /^2 reads of this statement/);
    assert.deepEqual(
      health.reading().slowReads.map((r) => [r.sql, r.count]),
      [['SELECT 1 AS one WHERE 1 = 1', 2]],
    );
  } finally {
    db.close();
  }
});

test('a read under the threshold is tallied nowhere', () => {
  const reads = new SlowReadTally(() => 0);
  reads.read('SELECT 1', 249);
  assert.equal(reads.drain().size, 0);
});

test('/api/health carries the runtime reading, from a system whose store reads are timed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runtime-health-'));
  const sampler = new FakeSampler();
  let t = 0;
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
      loopDelaySampler: sampler,
      readClock: () => (t += 1_000),
    },
  );
  const { app } = await buildApp(system);
  try {
    sampler.delays(10, 12, 7_500);
    system.runtimeHealth.tick();

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json<HealthPayload>();
    assert.equal(body.ok, true);
    assert.equal(body.runtime.eventLoop?.maxMs, 7_500);
    assert.ok(body.runtime.slowReads.length > 0, 'every store read took a second on the injected clock');

    const logged = system.store.errors
      .listErrorsSince('1970-01-01T00:00:00.000Z')
      .filter((e) => e.source === 'runtime');
    assert.ok(
      logged.some((e) => e.message.startsWith('the event loop was blocked')),
      'the stall reaches the error log',
    );
    assert.ok(
      logged.some((e) => e.message.startsWith('a store read took')),
      'and so does the slow read',
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('start enables the sampler and stop disables it', () => {
  const clock = { at: 0 };
  const { sampler, health } = watch(clock);
  health.start();
  assert.equal(sampler.enabled, true);
  health.stop();
  assert.equal(sampler.enabled, false);
});
