import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import { issueOriginRef } from '../src/issueOrigins.js';
import { ticketCriteria } from '../src/criteria/ticketCriteria.js';
import { ALIGNING_REASON } from '../src/intake/sitting.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Agent, GoalCriteriaAlignment, GoalCriteriaVersion, Issue } from '../src/types.js';
import { failAppraisalOpen, spentAppraisalAttempts } from './support/plans.js';

// → docs/spec/08-planning.md#the-alignment-check

const TICKET = [
  'Refunds are slow.',
  '',
  '## Acceptance criteria',
  '- A refund posts within a minute.',
  '- The customer is emailed.',
  '',
  '## Notes',
  'Nothing here.',
].join('\n');

test("the ticket's criteria are read from a markdown heading, a bold line, or an Azure heading", () => {
  assert.equal(ticketCriteria(TICKET), '- A refund posts within a minute.\n- The customer is emailed.');
  assert.equal(ticketCriteria('Intro\n\n**Acceptance criteria:**\n1. It works\n'), '1. It works');
  assert.equal(
    ticketCriteria('<h3>Description</h3>\n<p>x</p>\n<h3>Acceptance criteria</h3>\n<ul><li>It works</li></ul>'),
    '<ul><li>It works</li></ul>',
  );
  assert.equal(ticketCriteria('Just do the thing.'), null);
  assert.equal(ticketCriteria('## Acceptance criteria\n\n## Next'), null, 'an empty section is no criteria');
});

function issue(body: string): Issue {
  return { id: 'issue_12', number: 12, title: 'Refunds', body, state: 'open', labels: [], linkedPrNumber: null };
}

const criteria: GoalCriteriaVersion = {
  id: 'crit_1',
  originRef: 'issue:12',
  version: 1,
  supersedes: null,
  text: 'Refunds post fast and the customer hears about it.',
  author: null,
  reason: null,
  authoredAt: '2026-07-25T00:00:00.000Z',
};

function context(body: string, extra: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: '2026-07-25T12:00:00.000Z', pullRequests: [], issues: [issue(body)] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    closedSittings: new Set(),
    goalCriteria: [criteria],
    ...extra,
    recentDecisions: spentAppraisalAttempts(12),
  };
}

const decide = (body: string, extra: Partial<DispatchContext> = {}) =>
  new RuleDispatcher({ defaultBranch: 'main', planning: DEFAULT_PLANNING }).decide(context(body, extra));

const alignmentAction = (result: Awaited<ReturnType<typeof decide>>) =>
  result.actions.find((a) => a.type === 'dispatch_desk_agent' && a.rule === 'criteria-alignment');

test('an open sitting with criteria on both sides dispatches one desk agent, handed both and nothing else', async () => {
  const result = await decide(TICKET);
  const action = alignmentAction(result);
  assert.ok(action && action.type === 'dispatch_desk_agent');
  assert.equal(action.originRef, issueOriginRef('criteriaAlignment', 12));
  assert.ok(action.prompt.includes('A refund posts within a minute.'));
  assert.ok(action.prompt.includes(criteria.text));
  assert.doesNotMatch(action.prompt, /Refunds are slow/, 'the rest of the ticket is not the question');
});

test('nothing is dispatched where there is nothing to compare or the question is answered', async () => {
  assert.equal(alignmentAction(await decide('No criteria in here.')), undefined, 'the ticket has none');
  assert.equal(alignmentAction(await decide(TICKET, { goalCriteria: [] })), undefined, 'the operator wrote none');
  assert.equal(
    alignmentAction(await decide(TICKET, { closedSittings: new Set(['issue:12']) })),
    undefined,
    'the sitting has closed',
  );
  assert.equal(alignmentAction(await decide(TICKET, { closedSittings: null })), undefined, 'the gate is off');
  const read: GoalCriteriaAlignment = {
    id: 'a1',
    originRef: 'issue:12',
    version: 1,
    criteriaId: 'crit_1',
    verdict: 'aligned',
    summary: 'Same thing.',
    points: [],
    agentId: null,
    decidedAt: '2026-07-25T00:00:00.000Z',
    pressedOnAt: null,
  };
  assert.equal(alignmentAction(await decide(TICKET, { criteriaAlignments: [read] })), undefined, 'already read');
  assert.ok(
    alignmentAction(await decide(TICKET, { criteriaAlignments: [read], goalCriteria: [{ ...criteria, version: 2 }] })),
    'a revision is a new question',
  );
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-align-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: dir,
    heartbeatIntervalMs: 999_999,
    prediction: { enabled: false },
    goalCriteria: { enabled: true },
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
}

async function callTool(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session);
  const result = (await session.call('criteria_alignment', args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('the whole round: dispatched in the sitting, recorded by the tool, shown, and pressed on past', async () => {
  const system = build();
  const { app } = await buildApp(system);
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Refunds', body: TICKET });
  failAppraisalOpen(system.store, 1);
  const written = await app.inject({
    method: 'POST',
    url: '/api/goals/1/criteria',
    payload: { text: 'Refunds are instant and nobody is emailed.' },
  });
  assert.equal(written.statusCode, 200);

  await system.harness.runCycle('manual');
  const task = system.store.tasks.listTasks().find((t) => t.originRef === issueOriginRef('criteriaAlignment', 1));
  assert.ok(task, 'the alignment check is dispatched while the sitting is open');
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    world: { issues: { number: number; pickup: { status: string; reasons: string[] } }[] };
  };
  assert.deepEqual(state.world.issues.find((i) => i.number === 1)?.pickup, {
    eligible: false,
    status: 'sitting',
    reasons: [ALIGNING_REASON],
  } as never);

  const agent = system.store.agents.listAgents().find((a) => a.taskId === task.id)!;
  const wrongly = await callTool(system, agent, {
    version: 1,
    verdict: 'aligned',
    summary: 'Mostly.',
    points: [{ tag: 'contradicts', point: 'Emailing' }],
  });
  assert.equal(wrongly.isError, true, 'a contradiction makes the verdict conflicting');

  const recorded = await callTool(system, agent, {
    version: 1,
    verdict: 'conflicting',
    summary: 'The ticket emails the customer; you say nobody is emailed.',
    points: [
      { tag: 'matches', point: 'Refunds are fast' },
      { tag: 'contradicts', point: 'Whether the customer is emailed' },
    ],
  });
  assert.equal(recorded.isError, false, recorded.text);

  const reading = (await app.inject({ method: 'GET', url: '/api/goals/1/criteria' })).json() as {
    alignment: GoalCriteriaAlignment;
  };
  assert.equal(reading.alignment.verdict, 'conflicting');
  assert.equal(reading.alignment.points.length, 2);
  assert.equal(reading.alignment.pressedOnAt, null);

  const closed = await app.inject({ method: 'POST', url: '/api/goals/1/reveal' });
  assert.equal(closed.statusCode, 200);
  assert.notEqual(
    system.store.goalCriteria.getAlignment('issue:1', 1)?.pressedOnAt ?? null,
    null,
    'closing the sitting over a conflict is recorded beside the verdict',
  );

  await app.close();
  system.store.close();
});
