import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { deliveryHold } from '../src/delivery/delivery.js';
import type { Agent, Issue, IssueDelivery } from '../src/types.js';

// The planner's other verdict: the goal is already met, so no plan is written at
// all. What it records, what it refuses, and the thing it exists to stop — a plan
// with a part invented so that there is something to submit.

const NOW = '2026-08-26T12:00:00.000Z';

function testConfig(): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-notneeded-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function spawnAgent(system: System, originRef: string): Agent {
  const t = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'plan/issue/12',
    originRef,
  });
  return system.agents.spawn(t, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/** The origins the dispatcher would put an agent on this cycle. */
function origins(actions: { type: string; originRef?: string | null }[]): string[] {
  return actions.filter((a) => a.type.startsWith('dispatch_')).map((a) => a.originRef ?? '');
}

const FOUND = {
  summary: 'the retry the ticket asks for is already in the client, added in PR #40',
  detail:
    '`src/integrations/http.ts` retries on 429 and 5xx with the backoff the ticket describes; its test covers both.',
};

test('plan_not_needed is advertised under its name in the allow-list', () => {
  assert.ok(MCP_TOOL_NAMES.includes('plan_not_needed'), 'a tool missing from names.ts connects but is never callable');
});

test('a planner’s verdict lands as a delivery, attributed from the credential', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');
  const res = await callTool(system, agent, 'plan_not_needed', FOUND);
  assert.equal(res.isError, false);

  const delivery = system.store.getDelivery('issue:12');
  assert.equal(delivery?.by, 'planner', 'the author is its own — not the assessor, who judged nothing here');
  assert.equal(delivery?.summary, FOUND.summary);
  assert.equal(delivery?.detail, FOUND.detail, 'the working behind the verdict is what makes it reviewable');
  assert.equal(delivery?.agentId, agent.id, 'attribution is structural — the tool takes no issue argument');
  // The verdict must not read as a plan: nothing is written to the plan graph, so
  // no part is ever scheduled and the goal page shows no decomposition.
  assert.equal(system.store.getPlanByOrigin('issue:12'), null, 'no plan row — that is the whole point');
  assert.match(res.text, /not closed|human decision/, 'the planner must not believe it closed the ticket');
  system.store.close?.();
});

/**
 * The reason the verdict is a delivery rather than a note: the same predicate the
 * assessor's `delivered` is read through holds the issue out of *both* rules the
 * planner would otherwise be re-dispatched by.
 */
test('the verdict parks the issue, so neither a planner nor a pickup agent goes out again', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');
  await callTool(system, agent, 'plan_not_needed', FOUND);
  const delivery = system.store.getDelivery('issue:12') as IssueDelivery;

  const issue: Issue = {
    id: 'i12',
    number: 12,
    title: 'Retry the flaky calls',
    body: 'the client should retry',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
  assert.ok(deliveryHold(delivery, issue), 'the hold is what the dispatcher reads');

  const ctx: DispatchContext = {
    world: { takenAt: NOW, pullRequests: [], issues: [issue] },
    plans: [],
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    deliveries: [delivery],
  };
  const { actions } = await new RuleDispatcher().decide(ctx);
  const dispatched = origins(actions);
  assert.deepEqual(
    dispatched.filter((o) => o === 'issue:12' || o === 'issue:12:plan'),
    [],
    'a goal the planner found already met is neither planned again nor picked up',
  );
  system.store.close?.();
});

test('every other kind of agent is refused, and pointed at the verdict that is its own', async () => {
  const system = build();
  const remedies: [string, RegExp][] = [
    ['issue:12', /conclude_work/],
    ['issue:12:part:schema', /conclude_part/],
    ['issue:12:assess', /assess_issue/],
    ['issue:12:appraisal', /appraise_issue/],
    ['pr:40:ci', /planning agent/],
  ];
  for (const [origin, remedy] of remedies) {
    const agent = spawnAgent(system, origin);
    const res = await callTool(system, agent, 'plan_not_needed', FOUND);
    assert.equal(res.isError, true, `${origin} is not planning, so it has no plan to decline to write`);
    assert.match(res.text, remedy, 'refusals name the tool that is theirs');
  }
  assert.equal(system.store.getDelivery('issue:12'), null, 'and nothing is written');
  system.store.close?.();
});

/**
 * A replan is the one planning dispatch this verdict cannot settle: the plan row
 * would go on owning the issue (`planInFlight` reads `planning` as more work) while
 * the delivery parked pickup, and any part already dispatched would keep running
 * underneath a goal marked delivered.
 */
test('a replan is refused, because the plan it would leave standing still owns the issue', async () => {
  const system = build();
  system.store.upsertPlan({ originRef: 'issue:12', title: 'Split it', status: 'planning', reason: 'because' });

  const agent = spawnAgent(system, 'issue:12:plan');
  const res = await callTool(system, agent, 'plan_not_needed', FOUND);
  assert.equal(res.isError, true);
  assert.match(res.text, /plan_submit/, 'the amendment is the way out, and the refusal says so');
  assert.equal(system.store.getDelivery('issue:12'), null, 'nothing is written');
  system.store.close?.();
});

/**
 * The silent one. `recordDelivery` clears a standing shortfall through the
 * exclusion matrix, so without this refusal a planner could erase an assessor's
 * "the goal is not reached" — a verdict cast against the delivered state, by an
 * agent that had it in front of it — with nothing anywhere going red.
 */
test('a standing shortfall is not overturned, and survives the attempt', async () => {
  const system = build();
  system.store.recordShortfall({
    originRef: 'issue:12',
    cause: 'goal',
    summary: 'the retry is there but the ticket also asks for a metric, and there is none',
    by: 'assessor',
  });

  const agent = spawnAgent(system, 'issue:12:plan');
  const res = await callTool(system, agent, 'plan_not_needed', FOUND);
  assert.equal(res.isError, true);
  assert.match(res.text, /not.*reached|missing/i);
  assert.ok(system.store.getShortfall('issue:12'), 'the assessor’s verdict is still on record');
  assert.equal(system.store.getDelivery('issue:12'), null);
  system.store.close?.();
});

test('the account is required, and a blob summary is refused at the boundary', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');

  const bare = await callTool(system, agent, 'plan_not_needed', { summary: FOUND.summary });
  assert.equal(bare.isError, true, 'a planner contradicting a ticket has to show its working');
  assert.match(bare.text, /detail is required/);

  const blob = await callTool(system, agent, 'plan_not_needed', {
    summary: 'ALREADY THERE: the retry\nEVIDENCE: PR #40',
    detail: FOUND.detail,
  });
  assert.equal(blob.isError, true);
  assert.match(blob.text, /one line/i);

  assert.equal(system.store.getDelivery('issue:12'), null, 'a rejected verdict writes nothing');
  system.store.close?.();
});
