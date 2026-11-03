import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { MCP_TOOL_NAMES, UNIVERSAL_TOOLS, toolsForRule } from '../src/mcp/names.js';
import type { Agent } from '../src/types.js';

// → docs/spec/40-discussions.md#what-fleet-agents-write

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(discussions: boolean = true): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-discussion-tool-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      repoRoot: dir,
      ...(discussions ? { discussionsDir: join(dir, 'vault') } : {}),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function spawnAgent(system: System, originRef: string, rule: string = 'issue-plan'): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'plan/issue/12',
    originRef,
    originTitle: 'Export to CSV',
    rule,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('discussion_add', args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('discussion_add is named, and advertised to every agent', () => {
  assert.ok(MCP_TOOL_NAMES.includes('discussion_add'));
  assert.ok(UNIVERSAL_TOOLS.includes('discussion_add'));
  assert.ok(toolsForRule('plan-part').has('discussion_add'));
  assert.ok(toolsForRule('pr-review').has('discussion_add'));
});

test("a question lands in the agent's own story's file, authored as the agent, and holds the story", async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Export to CSV', body: 'Please.' });
  await system.harness.runCycle('manual');
  const agent = spawnAgent(system, 'issue:12:plan');
  const task = system.store.tasks.getTask(agent.taskId)!;

  const added = await callTool(system, agent, { kind: 'question', body: 'Drop empty columns?' });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /holds the next dispatch/);

  const doc = system.discussions.read(12);
  assert.ok(doc);
  assert.match(doc.path, /12 Export to CSV\.md$/, 'the first write names the file after the issue');
  assert.equal(doc.frontMatter.kind, 'story');
  const entry = doc.entries.at(-1)!;
  assert.deepEqual(
    [entry.kind, entry.state, entry.author, entry.body],
    ['question', 'open', `agent issue-plan#${task.id}`, 'Drop empty columns?'],
  );
  system.store.close();
});

test('a part, a reviewer of the story’s pull request and a note each write to the same story', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Export to CSV', body: 'Please.' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Export', branch: 'issue/12/whole' });
  await system.harness.runCycle('manual');

  const part = await callTool(system, spawnAgent(system, 'issue:12:part:whole', 'plan-part'), {
    kind: 'note',
    body: 'The writer streams.',
  });
  assert.equal(part.isError, false, part.text);
  const reviewer = await callTool(system, spawnAgent(system, 'pr:7:review', 'pr-review'), {
    kind: 'idea',
    body: 'Offer XLSX too.',
  });
  assert.equal(reviewer.isError, false, reviewer.text);
  const kinds = system.discussions.read(12)!.entries.map((e) => [e.kind, e.state]);
  assert.deepEqual(kinds, [
    ['note', null],
    ['idea', 'open'],
  ]);
  system.store.close();
});

test('a decision is refused — decisions are the operator’s', async () => {
  const system = build();
  const refused = await callTool(system, spawnAgent(system, 'issue:12:plan'), {
    kind: 'decision',
    body: 'Use the browser download.',
  });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /operator's alone/);
  assert.equal(system.discussions.read(12), null, 'nothing was written');
  system.store.close();
});

test('an agent with no story behind its origin is refused, and so is any write with discussions off', async () => {
  const system = build();
  const job = await callTool(system, spawnAgent(system, 'feature-summary:9', 'feature-summary'), {
    kind: 'note',
    body: 'x',
  });
  assert.equal(job.isError, true);
  assert.match(job.text, /neither/);
  system.store.close();

  const off = build(false);
  const refused = await callTool(off, spawnAgent(off, 'issue:12:plan'), { kind: 'note', body: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Discussions are off/);
  off.store.close();
});

test('an empty body is refused', async () => {
  const system = build();
  const refused = await callTool(system, spawnAgent(system, 'issue:12:plan'), { kind: 'note', body: '   ' });
  assert.equal(refused.isError, true);
  system.store.close();
});
