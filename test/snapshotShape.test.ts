import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

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
  system.store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });

  const snapshot = buildStateSnapshot(system);
  const shipped = snapshot.tasks.find((t) => t.id === task.id);
  assert.ok(shipped, 'the task is on the snapshot');
  assert.ok(!('prompt' in shipped), 'and carries no prompt');
  assert.ok(!JSON.stringify(snapshot).includes(PROMPT), 'no prompt text reaches the payload by any route');

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

  const summary = system.store.listTasks().find((t) => t.id === task.id);
  assert.ok(summary);
  assert.deepEqual(
    Object.keys(summary).sort(),
    Object.keys(system.store.getTask(task.id)!)
      .filter((k) => k !== 'prompt')
      .sort(),
    'the narrow read returns every column the whole row has, except the prompt',
  );
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
