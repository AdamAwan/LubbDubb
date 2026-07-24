import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeArgs,
  buildClaudeStreamArgs,
  buildInitialMessage,
  PROTOCOL_SYSTEM_PROMPT,
} from '../src/agents/agentProtocol.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Task } from '../src/types.js';

test('buildClaudeArgs injects the protocol system prompt and permission mode', () => {
  const args = buildClaudeArgs({ permissionMode: 'acceptEdits', extraArgs: ['--model', 'x'] });
  const i = args.indexOf('--append-system-prompt');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], PROTOCOL_SYSTEM_PROMPT);
  const p = args.indexOf('--permission-mode');
  assert.ok(p >= 0);
  assert.equal(args[p + 1], 'acceptEdits');
  assert.deepEqual(args.slice(-2), ['--model', 'x']);
});

test('buildClaudeArgs omits permission mode when unset', () => {
  const args = buildClaudeArgs({});
  assert.equal(args.includes('--permission-mode'), false);
});

test('buildClaudeArgs pins a chosen session id on a fresh launch', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const args = buildClaudeArgs({ sessionId: id });
  assert.equal(args[args.indexOf('--session-id') + 1], id);
  assert.equal(args.includes('--resume'), false);
});

test('buildClaudeArgs resumes an existing session and re-appends the protocol', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const args = buildClaudeArgs({ sessionId: id, resume: true });
  assert.equal(args[args.indexOf('--resume') + 1], id);
  // --session-id and --resume are mutually exclusive: don't set a new id on resume.
  assert.equal(args.includes('--session-id'), false);
  // The appended system prompt must be re-sent so waiting/done detection survives resume.
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], PROTOCOL_SYSTEM_PROMPT);
});

test('buildClaudeArgs ignores resume when no session id is given', () => {
  const args = buildClaudeArgs({ resume: true });
  assert.equal(args.includes('--resume'), false);
  assert.equal(args.includes('--session-id'), false);
});

test('buildInitialMessage is the task prompt', () => {
  const task = { prompt: 'do the thing' } as Task;
  assert.equal(buildInitialMessage(task), 'do the thing');
});

test('buildClaudeStreamArgs requests headless bidirectional stream-json', () => {
  const args = buildClaudeStreamArgs({ permissionMode: 'acceptEdits' });
  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes('--permission-mode'));
});

function claudeModeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-claude-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'pty',
    agentPromptDelayMs: 0, // send immediately in tests
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
}

test('claude-mode agents launch with protocol args and get the task typed in', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(claudeModeConfig(), { backend });

  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Add login' });
  await system.harness.runCycle('manual');

  // Spawned with our injected system prompt.
  const spawn = backend.spawned[0]!;
  assert.ok(spawn.args.includes('--append-system-prompt'));
  assert.ok(spawn.args.includes('--permission-mode'));

  // The task prompt is typed into the session (delay 0 -> next tick).
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(
    backend.last().writes.some((w) => w.includes('Add login')),
    'expected the task prompt to be typed in',
  );
  system.store.close();
});

test('claude-mode still detects the protocol sentinels from real output', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(claudeModeConfig(), { backend });
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'X' });
  await system.harness.runCycle('manual');

  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  // Agent (a real claude, following the appended system prompt) announces it needs input.
  backend.last().emit('I need to know the target framework.\n@@LUBBDUBB_WAITING:Which framework?@@\n');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  assert.equal(system.store.listOpenEscalations().length, 1);
  system.store.close();
});
