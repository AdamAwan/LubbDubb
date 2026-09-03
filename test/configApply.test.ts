import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type Config } from '../src/config.js';
import { LiveConfig } from '../src/configApply.js';
import { RuntimeControl } from '../src/runtimeControl.js';
import type { CiPolicy } from '../src/ci/ciPolicy.js';

/**
 * What a config change does to a *running* harness.
 *
 * The arms are asserted through their effect on the thing that holds the value,
 * never through the classification alone: "live" means the consumer was re-seated,
 * and a test that only checked the flag would pass on the day the arm stopped
 * doing anything.
 */

/** The dispatcher's seam, recording what it was handed. */
function recordingDispatcher(): { seen: CiPolicy[]; setCiPolicy: (ci: CiPolicy) => void } {
  const seen: CiPolicy[] = [];
  return { seen, setCiPolicy: (ci: CiPolicy) => seen.push(ci) };
}

function harness(overrides: Partial<Config> = {}) {
  const running = loadConfig({ maxConcurrentAgents: 3, ...overrides });
  const runtimeControl = new RuntimeControl(running.maxConcurrentAgents, running.startPaused);
  const dispatcher = recordingDispatcher();
  return { running, runtimeControl, dispatcher, live: new LiveConfig({ running, runtimeControl, dispatcher }) };
}

test('the agent cap applies now: the configured value and the live one both move', () => {
  const { running, runtimeControl, live } = harness();

  const changes = live.apply(loadConfig({ maxConcurrentAgents: 6 }));

  assert.deepEqual(
    changes.map((change) => ({ path: change.path, applied: change.applied })),
    [{ path: 'maxConcurrentAgents', applied: true }],
  );
  assert.equal(runtimeControl.cap, 6, 'the live cap was re-seated, not just the file');
  assert.equal(running.maxConcurrentAgents, 6, 'and the object every late reader holds');
  assert.deepEqual(live.pending(), [], 'nothing is waiting for a restart');
});

test('the CI policy applies now by re-seating the dispatcher, not by assignment alone', () => {
  const { running, dispatcher, live } = harness();
  const checks = [{ match: 'build', onFailure: 'dispatch' as const }];

  live.apply(loadConfig({ maxConcurrentAgents: 3, ci: { checks } }));

  assert.deepEqual(
    dispatcher.seen,
    [{ checks }],
    'the dispatcher took a copy at construction and had to be handed one',
  );
  assert.deepEqual(running.ci.checks, checks);
});

test('the state colours apply now, because the snapshot reads the running config each poll', () => {
  const { running, live } = harness();
  const colours = { Worthyable: '#7fb3ff' };

  live.apply(loadConfig({ maxConcurrentAgents: 3, issueStateColours: colours }));

  assert.deepEqual(running.issueStateColours, colours, 'the object the snapshot builder reads by reference');
  assert.deepEqual(live.pending(), [], 'no restart is owed for a colour');
});

test('a key with no arm lands in the file and is reported as pending, not applied', () => {
  const { running, live } = harness();

  const changes = live.apply(loadConfig({ maxConcurrentAgents: 3, agentMode: 'raw' }));

  assert.deepEqual(changes, [{ path: 'agentMode', from: 'stream', to: 'raw', applied: false }]);
  assert.deepEqual(
    live.pending().map((change) => change.path),
    ['agentMode'],
  );
  assert.equal(running.agentMode, 'stream', 'the running harness keeps the runtime it booted with');
});

test('editing a pending key twice leaves one row, saying where it started and where it is now', () => {
  const { live } = harness();
  const base = { maxConcurrentAgents: 3 };

  // Two *different* values, so the row has somewhere to move to: with the runtimes
  // down to two, the launch command is the restart-only key with room to edit twice.
  live.apply(loadConfig({ ...base, claudeCommand: 'claude-beta' }));
  live.apply(loadConfig({ ...base, claudeCommand: 'claude-canary' }));

  assert.deepEqual(live.pending(), [{ path: 'claudeCommand', from: 'claude', to: 'claude-canary', applied: false }]);
});

test('putting a pending key back to what the harness is running clears it', () => {
  const { live } = harness();
  const base = { maxConcurrentAgents: 3 };

  live.apply(loadConfig({ ...base, agentMode: 'raw' }));
  live.apply(loadConfig({ ...base }));

  assert.deepEqual(live.pending(), [], 'nothing is waiting for a restart any more');
});

test('one apply reports live and restart-only changes together, each saying which it is', () => {
  const { live } = harness();

  const changes = live.apply(loadConfig({ maxConcurrentAgents: 8, agentMode: 'raw' }));

  assert.deepEqual(changes.map((change) => `${change.path}:${change.applied ? 'now' : 'restart'}`).sort(), [
    'agentMode:restart',
    'maxConcurrentAgents:now',
  ]);
});

test('an unchanged config is not a change', () => {
  const { live } = harness();
  assert.deepEqual(live.apply(loadConfig({ maxConcurrentAgents: 3 })), []);
});
