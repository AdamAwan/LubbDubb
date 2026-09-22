import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../src/mcp/tools.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { AUTOMATION_NOTE, HUMAN_NOTE, renderPrFooter } from '../src/pr/prFooter.js';
import { composeDescribedBody } from '../src/pr/prDescription.js';
import type { ActionSink, PrCreateInput, SendResult } from '../src/sink/actionSink.js';
import type { McpTool } from '../src/mcp/protocol.js';
import type { Agent } from '../src/types.js';

// → docs/spec/07-pull-requests.md#the-footer

const BULLETS = [
  '- Sync cursors were rebuilt on every boot, so a restart replayed the whole backlog.',
  '- Stores the cursor per source and reads it at startup.',
].join('\n');

test("a part agent's bullets ship as written, above the footer and nothing else", async () => {
  const { tool, opened } = wire();
  const result = await tool.handler({ summary: 'sync cursor table', body: BULLETS });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const body = opened[0]!.body;

  const footer = renderPrFooter({ issueNumber: 12, issueTitle: 'Resume the sync', position: 1, total: 1 });
  assert.equal(
    body,
    [BULLETS, footer].join('\n\n'),
    'the body is the bullets, a rule, the reference and the automation note — and nothing else',
  );
  assert.doesNotMatch(body, /Asked for|Cannot be undone|Not verified|How far it reaches/);
});

test('a body the agent did not write leaves the footer standing alone', async () => {
  const { tool, opened } = wire();
  await tool.handler({ summary: 'sync cursor table' });
  assert.equal(opened[0]!.body.startsWith('---'), true);
  assert.equal(opened[0]!.body.endsWith(AUTOMATION_NOTE), true);
});

test('a part names its position and the whole issue it belongs to', () => {
  const footer = renderPrFooter({ issueNumber: 12, issueTitle: 'Resume the sync', position: 2, total: 2 });
  assert.match(footer, /^---\n\nPart 2\/2 of #12 — Resume the sync\n🤖 Automated PR from LubbDubb$/);
  assert.doesNotMatch(footer, /closes|fixes/i);
});

test("an operator's description is marked as a person's, above the footer", () => {
  const footer = renderPrFooter({ issueNumber: 12, issueTitle: 'Resume the sync', position: 1, total: 1 });
  const body = composeDescribedBody('  The cursor is read back at startup.  ', footer);
  assert.equal(body, ['The cursor is read back at startup.', HUMAN_NOTE, footer].join('\n\n'));
});

test('a mark over nothing labels an author who wrote nothing', () => {
  assert.equal(composeDescribedBody('', 'footer only'), 'footer only');
  assert.equal(composeDescribedBody('head only', '   '), ['head only', HUMAN_NOTE].join('\n\n'));
});

function wire(): { tool: McpTool; opened: PrCreateInput[] } {
  const system = build();
  const opened: PrCreateInput[] = [];
  const sink = {
    createPullRequest: async (input: PrCreateInput): Promise<SendResult> => {
      opened.push(input);
      return { ok: true };
    },
  } as unknown as ActionSink;

  const agent = spawnAgent(system);
  const tool = buildTools(
    {
      store: system.store,
      agents: system.agents,
      openPr: { sink, defaultBranch: 'main', prompts: system.prompts, watchLabel: '', prRefStyle: '#' },
    },
    { agent, task: system.store.tasks.getTask(agent.taskId)! },
  ).find((t) => t.name === 'open_pr');
  assert.ok(tool, 'open_pr is built');
  return { tool, opened };
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-prbody-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  system.store.world.setWorldBaseline({
    takenAt: '2026-09-01T00:00:00.000Z',
    pullRequests: [],
    issues: [
      {
        id: 'issue_12',
        number: 12,
        title: 'Resume the sync',
        body: '',
        state: 'open',
        labels: [],
        linkedPrNumber: null,
      },
    ],
  });
  const plan = system.store.plans.upsertPlan({ originRef: 'issue:12', title: 'Resume the sync', status: 'active' });
  system.store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'cursor',
      seq: 1,
      title: 'The cursor',
      scope: 'src/store/',
      touches: [],
      dependsOn: [],
      rationale: null,
      acceptance: '- The cursor is stored per source.\n- Resume reads the cursor at boot.',
      size: null,
      expectedKind: null,
    },
  ]);
  return system;
}

function spawnAgent(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Work issue:12 part cursor',
    prompt: 'do it',
    branch: 'issue/12/cursor',
    originRef: 'issue:12:part:cursor',
    originTitle: 'The cursor',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}
