import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * What `/api/state` is allowed to carry.
 *
 * The snapshot is refetched on every `dirty`, `world:changed`, `control:changed`,
 * `world:events` and `cycle:end` — several times a pulse, per open cockpit. So a
 * bulk-text column that creeps onto one of its collections is not a size
 * regression, it is a *rate* one, and it is invisible: the payload still
 * validates, the cockpit still draws, and the only symptom is that every action
 * takes seconds. On the deployment that prompted this, task prompts were 17.4 MB
 * of a 24 MB payload that nothing rendered.
 *
 * These assertions are structural rather than about sizes, because a size
 * threshold on an in-memory database measures nothing.
 */

function testSystem(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-snapshot-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  // No test here dispatches, but `config.repoRoot` defaults to `process.cwd()` —
  // the real manager would cut a branch in this checkout on any path that did.
  return buildSystem(config, { worktrees: new FakeWorktreeManager(), errorMirror: () => {} });
}

const PROMPT = `a rendered agent prompt, ${'x'.repeat(4096)}`;

test('the snapshot ships tasks without their prompts', () => {
  const system = testSystem();
  const task = system.store.createTask({
    kind: 'code',
    title: 'Fix the thing',
    prompt: PROMPT,
    branch: 'issue/1',
    originRef: 'issue:1',
  });
  // The snapshot's task list is the tasks of the agents it ships, so a task with
  // nobody on it is not on the wire at all — which is a different assertion from
  // this one, and the one below would pass vacuously without an agent here.
  system.store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });

  const snapshot = buildStateSnapshot(system);
  const shipped = snapshot.tasks.find((t) => t.id === task.id);
  assert.ok(shipped, 'the task is on the snapshot');
  assert.ok(!('prompt' in shipped), 'and carries no prompt');
  // Belt and braces: the field could come back under another name, or ride
  // along inside a nested view built from the same rows.
  assert.ok(!JSON.stringify(snapshot).includes(PROMPT), 'no prompt text reaches the payload by any route');

  // The prompt is still there to be read one row at a time — which is what every
  // production reader of it does.
  assert.equal(system.store.getTask(task.id)?.prompt, PROMPT);
  system.store.close();
});

test('a summary row is the whole task minus its prompt', () => {
  const system = testSystem();
  const task = system.store.createTask({
    kind: 'code',
    title: 'Fix the thing',
    prompt: PROMPT,
    branch: 'issue/1',
    originRef: 'issue:1',
    originTitle: 'The thing',
    originSummary: 'It is broken',
    dispatchReason: 'because',
    rule: 'issue-pickup',
    ciChecks: ['dotnet test'],
    model: 'claude-opus-5',
    effort: 'high',
    profile: 'deep',
    profileSource: 'rule',
  });

  // `listTasks` names its columns rather than starring, so a column added to the
  // table and not to that list reads back as absent — silently, since the field
  // is optional on the domain type. This is what says so.
  const summary = system.store.listTasks().find((t) => t.id === task.id);
  assert.ok(summary);
  assert.deepEqual(
    Object.keys(summary).sort(),
    Object.keys(system.store.getTask(task.id)!)
      .filter((k) => k !== 'prompt')
      .sort(),
    'the narrow read returns every column the whole row has, except the prompt',
  );
  // And the values survive the trip — a column named but mapped wrong would pass
  // the key comparison above.
  assert.deepEqual({ ...system.store.getTask(task.id)!, prompt: undefined }, { ...summary, prompt: undefined });
  system.store.close();
});

test('the snapshot ships only the escalations still waiting on a person', () => {
  const system = testSystem();
  const open = system.store.createEscalation({
    type: 'answer_question',
    prompt: 'Which database?',
    context: { recentOutput: 'a transcript tail'.repeat(64) },
    taskId: null,
    agentId: null,
  });
  const settled = system.store.createEscalation({
    type: 'answer_question',
    prompt: 'Which queue?',
    context: { recentOutput: 'another transcript tail'.repeat(64) },
    taskId: null,
    agentId: null,
  });
  system.store.answerEscalation(settled.id, 'the first one');

  const snapshot = buildStateSnapshot(system);
  assert.deepEqual(
    snapshot.escalations.map((e) => e.id),
    [open.id],
    'a settled escalation — and the transcript tail it carries — stays on the server',
  );
  system.store.close();
});
