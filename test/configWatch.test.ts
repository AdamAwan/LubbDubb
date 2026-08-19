import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromText, type Config } from '../src/config.js';
import { LiveConfig } from '../src/configApply.js';
import { watchConfigFile } from '../src/configWatch.js';
import { RuntimeControl } from '../src/runtimeControl.js';
import type { CiPolicy } from '../src/ci/ciPolicy.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';

/**
 * The file, watched — the half of #401 that keeps `lubbdubb.config.json`
 * first-class. What is asserted is that a hand edit produces the *same* outcome a
 * cockpit save does, because both go through one apply path, and that a
 * half-typed file never reaches the running harness.
 */

function recorder(): ErrorRecorder & { entries: ErrorLogInput[] } {
  const entries: ErrorLogInput[] = [];
  return {
    entries,
    record(input: ErrorLogInput): ErrorLogEntry {
      entries.push(input);
      return {
        id: `${entries.length}`,
        source: input.source,
        message: input.message,
        detail: input.detail ?? null,
        createdAt: '',
      } satisfies ErrorLogEntry;
    },
  };
}

async function waitFor(what: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(why);
}

function fixture(initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-cfgwatch-'));
  const file = join(dir, 'lubbdubb.config.json');
  const write = (values: Record<string, unknown>): void =>
    writeFileSync(file, JSON.stringify({ dbPath: ':memory:', labelPrefix: '', ...values }, null, 2), 'utf8');
  write(initial);

  const running = loadConfigFromText(JSON.stringify({ dbPath: ':memory:', labelPrefix: '', ...initial }), file);
  const runtimeControl = new RuntimeControl(running.maxConcurrentAgents, running.startPaused);
  const seen: CiPolicy[] = [];
  const live = new LiveConfig({
    running,
    runtimeControl,
    dispatcher: { setCiPolicy: (ci: CiPolicy) => seen.push(ci) },
  });
  const errors = recorder();
  let changed = 0;
  const stop = watchConfigFile({
    filePath: file,
    liveConfig: live,
    errors,
    reload: (): Config => loadConfigFromText(readFileSync(file, 'utf8'), file),
    onChanged: () => changed++,
    intervalMs: 20,
  });
  return { file, write, running, runtimeControl, live, errors, stop, changed: () => changed };
}

test('an edit on disk applies a live key without a restart, exactly as a save does', async () => {
  const f = fixture({ maxConcurrentAgents: 3 });
  try {
    f.write({ maxConcurrentAgents: 7 });

    await waitFor(() => f.runtimeControl.cap === 7, 'the watcher should have re-seated the live cap');
    assert.equal(f.running.maxConcurrentAgents, 7);
    await waitFor(() => f.changed() === 1, 'open cockpits should have been told');
  } finally {
    f.stop();
  }
});

test('a restart-only edit is held as pending and leaves the running harness alone', async () => {
  const f = fixture({ agentMode: 'raw' });
  try {
    f.write({ agentMode: 'pty' });

    await waitFor(() => f.live.pending().length === 1, 'the change should be waiting for a restart');
    assert.deepEqual(
      f.live.pending().map((change) => [change.path, change.from, change.to]),
      [['agentMode', 'raw', 'pty']],
    );
    assert.equal(f.running.agentMode, 'raw', 'the harness keeps the runtime it booted with');
  } finally {
    f.stop();
  }
});

test('a half-typed file is recorded and dropped, never applied', async () => {
  const f = fixture({ maxConcurrentAgents: 3 });
  try {
    writeFileSync(f.file, '{ "maxConcurrentAgents": 9,', 'utf8');

    await waitFor(() => f.errors.entries.length === 1, 'the failure should have been recorded');
    assert.match(f.errors.entries[0]?.message ?? '', /could not be loaded, so the harness is still running/);
    assert.equal(f.running.maxConcurrentAgents, 3, 'the running config is untouched');
    assert.equal(f.changed(), 0, 'and nothing was announced to the cockpit');
  } finally {
    f.stop();
  }
});

test('a file rewritten with the same bytes is not a change', async () => {
  const f = fixture({ maxConcurrentAgents: 3 });
  try {
    f.write({ maxConcurrentAgents: 3 });
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(f.changed(), 0);
    assert.deepEqual(f.live.pending(), []);
  } finally {
    f.stop();
  }
});
