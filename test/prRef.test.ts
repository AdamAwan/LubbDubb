import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prRef, prRefStyle } from '../src/prRef.js';
import { currentPlanSummary, siblingContext } from '../src/plans/parts.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import { buildTools } from '../src/mcp/tools.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { Agent, Plan, PlanPart } from '../src/types.js';

// Azure DevOps reads `#12` as work item 12 and `!12` as pull request 12, and the
// two are disjoint id spaces — so a pull request named with the wrong sigil links
// confidently to an unrelated ticket. Nothing about that is red anywhere.

test('the sigil follows the source-control provider, and only Azure differs', () => {
  assert.equal(prRefStyle('azure'), '!');
  assert.equal(prRefStyle('github'), '#');
  assert.equal(prRefStyle('fake'), '#');
  assert.equal(prRef(40, '!'), '!40');
  assert.equal(prRef(40, '#'), '#40');
});

test("a part agent is shown its siblings' pull requests in the provider's own syntax", () => {
  const parts = [
    part('a', 1, { status: 'merged', prNumber: 40, branch: 'issue/12/a' }),
    part('b', 2, { status: 'ready' }),
  ];
  const { done } = siblingContext(parts, parts[1]!, '!');
  assert.match(done, /\(PR !40\)/);
  assert.doesNotMatch(done, /#40/, 'the agent copies what it is shown into its own PR description');
  assert.match(siblingContext(parts, parts[1]!, '#').done, /\(PR #40\)/);
});

test('a replanner and the plan status comment name a pull request the same way', () => {
  const parts = [part('a', 1, { status: 'merged', prNumber: 40, branch: 'issue/12/a' })];
  assert.match(currentPlanSummary(plan(), parts, '!'), /PR !40/);
  // Published on the tracker, where the wrong sigil is a live link to a work item.
  assert.match(renderPlanComment(plan(), parts, '!'), /PR !40/);
  assert.match(renderPlanComment(plan(), parts, '#'), /PR #40/);
});

test('open_pr tells the agent which sigil to write in the body it composes', () => {
  const system = build();
  const agent = spawnAgent(system);
  const azure = bodyGuidance(system, agent, '!');
  assert.match(azure, /!12/);
  assert.match(azure, /work item 12/, 'the reason is stated, not just the rule');
  assert.match(bodyGuidance(system, agent, '#'), /`#12`/);
});

/** The `body` argument's description, as the agent reads it before writing one. */
function bodyGuidance(system: System, agent: Agent, style: '#' | '!'): string {
  const tool = buildTools(
    {
      store: system.store,
      agents: system.agents,
      openPr: {
        sink: {} as ActionSink,
        defaultBranch: 'main',
        prompts: system.prompts,
        watchLabel: '',
        prRefStyle: style,
      },
    },
    { agent, task: system.store.getTask(agent.taskId)! },
  ).find((t) => t.name === 'open_pr');
  assert.ok(tool, 'open_pr is built');
  const schema = tool.inputSchema as { properties: { body: { description: string } } };
  return schema.properties.body.description;
}

// -- helpers -----------------------------------------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-prref-'));
  return buildSystem(
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
}

function spawnAgent(system: System): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Work issue:12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

function plan(): Plan {
  return {
    id: 'p1',
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
    diagnosis: null,
    approach: null,
    verification: null,
    alternatives: null,
    outOfScope: null,
    risks: null,
    openQuestions: null,
    document: null,
    evidence: [],
    statusCommentRef: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function part(slug: string, seq: number, over: Partial<PlanPart> = {}): PlanPart {
  return {
    id: `p1:${slug}`,
    planId: 'p1',
    slug,
    seq,
    title: `The ${slug} part`,
    scope: `src/${slug}/`,
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    touches: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}
