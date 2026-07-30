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

/** Pull the single `--settings` JSON object out of an argv, or null if absent. */
function settingsOf(args: string[]): Record<string, unknown> | null {
  const i = args.indexOf('--settings');
  if (i < 0) return null;
  return JSON.parse(args[i + 1]!) as Record<string, unknown>;
}

test('allowedTools become a permissions.allow fragment in --settings (stream)', () => {
  const allow = ['Bash(npm:*)', 'Bash(git:*)'];
  const args = buildClaudeStreamArgs({ permissionMode: 'acceptEdits', allowedTools: allow, fileEvents: true });
  const settings = settingsOf(args);
  assert.deepEqual((settings?.permissions as { allow: string[] }).allow, allow);
  // The file-events hook fragment is still present in the same object.
  assert.ok(settings?.hooks, 'file-events hook should merge alongside permissions');
});

test('allowedTools become a permissions.allow fragment in --settings (pty)', () => {
  const allow = ['Bash(gh:*)'];
  const args = buildClaudeArgs({
    permissionMode: 'acceptEdits',
    allowedTools: allow,
    statusLine: true,
    fileEvents: true,
  });
  const settings = settingsOf(args);
  assert.deepEqual((settings?.permissions as { allow: string[] }).allow, allow);
  // Merged alongside the other fragments, not replacing them.
  assert.ok(settings?.statusLine, 'status-line fragment should merge alongside permissions');
  assert.ok(settings?.hooks, 'file-events hook should merge alongside permissions');
});

test('the Bash allowlist never touches --allowedTools (MCP grants stay intact)', () => {
  const args = buildClaudeStreamArgs({
    allowedTools: ['Bash(npm:*)'],
    mcpConfigPath: '/tmp/mcp.json',
  });
  // permissions.allow carries the Bash rules...
  assert.deepEqual((settingsOf(args)?.permissions as { allow: string[] }).allow, ['Bash(npm:*)']);
  // ...while --allowedTools carries only the MCP grants, uncontaminated by Bash rules.
  const at = args[args.indexOf('--allowedTools') + 1]!;
  assert.ok(at.includes('mcp__lubbdubb__'), 'MCP grants present');
  assert.equal(at.includes('Bash'), false, '--allowedTools must not carry Bash rules');
});

test('no allowedTools means no permissions fragment', () => {
  assert.equal(settingsOf(buildClaudeStreamArgs({ allowedTools: [] })), null);
  assert.equal(settingsOf(buildClaudeArgs({ allowedTools: [] })), null);
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
    // The funnel in front of pickup defaults **on**; these tests are about the
    // agent transport, so pin it off and let rule 4 dispatch directly.
    planning: { enabled: false } as never,
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
  });
}

test('claude-mode agents launch with protocol args and get the task typed in', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(claudeModeConfig(), { backend });

  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');

  // Spawned with our injected system prompt.
  const spawn = backend.spawned[0]!;
  assert.ok(spawn.args.includes('--append-system-prompt'));
  assert.ok(spawn.args.includes('--permission-mode'));

  // The task prompt is typed into the session (delay 0 -> next tick).
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(
    backend.last().writes.some((w) => w.includes('issue #901')),
    'expected the task prompt to be typed in',
  );
  system.store.close();
});

test('claude-mode still detects the protocol sentinels from real output', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(claudeModeConfig(), { backend });
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'X' });
  await system.harness.runCycle('manual');

  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  // Agent (a real claude, following the appended system prompt) announces it needs input.
  backend.last().emit('I need to know the target framework.\n@@LUBBDUBB_WAITING:Which framework?@@\n');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  assert.equal(system.store.listOpenEscalations().length, 1);
  system.store.close();
});
