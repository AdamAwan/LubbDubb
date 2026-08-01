import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { hasPriorWork } from '../src/delivery/assessment.js';
import { issueOriginRole } from '../src/issueOrigins.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { foldWorkGraph } from '../src/graph/workGraph.js';
import type { Agent, Decision, Issue, IssueDelivery, Plan, Task } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// Rule 3e — the assessor. What makes it fire, what makes it stand down, and the
// one thing it must never do: let a second agent onto an issue it is judging.

const NOW = '2026-07-28T12:00:00.000Z';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [task()],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    steeringPriorities: [],
    agentHeadroom: 3,
    ...over,
  };
}

/**
 * The dispatcher with the assessor on — everything else default, and the
 * retrospective explicitly off: rule 3h fires on exactly the issues rule 3e has
 * finished with, so leaving it on would put a second dispatch in every assertion
 * here about a parked issue. It has its own tests (test/retrospective.test.ts).
 */
function assessor(): RuleDispatcher {
  return new RuleDispatcher({}, {}, undefined, 'main', {}, { enabled: true }, {}, {}, { enabled: false });
}

/** The funnel and the assessor both on — what a `single` verdict actually meets. */
function planningAssessor(): RuleDispatcher {
  return new RuleDispatcher(
    {},
    {},
    undefined,
    'main',
    { enabled: true },
    { enabled: true },
    {},
    { enabled: false },
    { enabled: false },
  );
}

function plan(status: Plan['status']): Plan {
  return {
    id: 'pl1',
    originRef: 'issue:12',
    title: 'Split it',
    status,
    reason: 'because',
    risks: null,
    outOfScope: null,
    document: null,
    discussing: false,
    statusCommentRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function origins(actions: { type: string; originRef?: string | null }[]): string[] {
  return actions.filter((a) => a.type.startsWith('dispatch_')).map((a) => a.originRef ?? '');
}

// -- the headline: what the bug was ------------------------------------------

test('an issue whose delivering PR has merged and left the world is assessed, not re-picked', async () => {
  // The world after a merge: the issue is still open (waiting on sign-off) and
  // `openPrForIssue` reads only the open list, so this is byte-for-byte rule 4's
  // precondition. Before the assessor, a second agent was dispatched here to redo
  // work already sitting on the default branch.
  const { actions } = await assessor().decide(ctx());

  assert.deepEqual(origins(actions), ['issue:12:assess']);
  const dispatch = actions.find((a) => a.type === 'dispatch_code_agent') as {
    branch: string;
    base?: string;
    rule: string;
  };
  assert.equal(
    dispatch.branch,
    'assess/issue/12',
    'its own namespace — git cannot put issue/12/assess beside issue/12',
  );
  assert.equal(dispatch.base, 'main', 'cut from the default branch, where the merged work actually is');
  assert.equal(dispatch.rule, 'issue-assess');
});

test('with the flag off nothing changes — the issue is picked up exactly as today', async () => {
  const { actions } = await new RuleDispatcher().decide(ctx());
  assert.deepEqual(origins(actions), ['issue:12'], 'off by default, so rule 4 is un-narrowed');
});

// -- the prior-work condition ------------------------------------------------

test('a fresh issue is picked up, not assessed', async () => {
  // Without this the assessor fires on every new issue: nothing is in flight
  // because nothing ever started, which satisfies every other precondition.
  const { actions } = await assessor().decide(ctx({ tasks: [] }));
  assert.deepEqual(origins(actions), ['issue:12']);
});

test('prior work is an origin that could have delivered something, and nothing else', () => {
  assert.equal(hasPriorWork(12, []), false);
  assert.equal(hasPriorWork(12, [task({ originRef: 'issue:12' })]), true);
  assert.equal(hasPriorWork(12, [task({ originRef: 'issue:12:part:schema' })]), true);
  assert.equal(hasPriorWork(12, [task({ originRef: 'issue:12:assess' })]), true, 'downstream evidence work happened');
  // The harness deliberating about an issue is not work having been done on it.
  assert.equal(hasPriorWork(12, [task({ originRef: 'issue:12:plan' })]), false);
  assert.equal(hasPriorWork(12, [task({ originRef: 'issue:12:assay' })]), false);
  assert.equal(hasPriorWork(12, [task({ originRef: 'issue:120' })]), false, 'a prefix match must not span numbers');
  assert.equal(hasPriorWork(12, [task({ originRef: 'pr:40:ci' })]), false);
  assert.equal(hasPriorWork(12, [task({ originRef: null })]), false);
});

test('every origin the harness dispatches under an issue is classified deliberately', () => {
  // The defect this replaces existed precisely because `issue:<n>:plan` was added
  // and nothing forced a decision about which side of the discriminator it fell.
  // An unrecognised suffix is the one case that cannot be enumerated, so it is
  // named: it does not count, which fails toward pickup — a redundant agent, which
  // is visible — rather than toward a parked issue, which is not.
  assert.deepEqual(
    Object.fromEntries(
      [
        'issue:12',
        'issue:12:part:schema',
        'issue:12:assess',
        'issue:12:retro',
        'issue:12:plan',
        'issue:12:assay',
        'issue:12:something-added-later',
        'issue:120',
        'pr:40:ci',
      ].map((ref) => [ref, issueOriginRole(12, ref)]),
    ),
    {
      'issue:12': 'work',
      'issue:12:part:schema': 'work',
      'issue:12:assess': 'evidence',
      'issue:12:retro': 'evidence',
      'issue:12:plan': 'deliberation',
      'issue:12:assay': 'deliberation',
      'issue:12:something-added-later': 'unrecognised',
      'issue:120': null,
      'pr:40:ci': null,
    },
  );
  assert.equal(issueOriginRole(12, null), null);
});

// -- the funnel's `single` arm -----------------------------------------------

test('an issue the planner routed to `single` is picked up, not assessed', async () => {
  // The bug: the planner's own task sits at `issue:12:plan`, which counted as work
  // having been done, so rule 3e fired on an issue nothing had ever built — and
  // suppressed the pickup that was the whole point of the `single` verdict. The
  // assessor then honestly reported nothing delivered, the shortfall replanned,
  // and the loop closed with no PR ever written.
  const { actions } = await planningAssessor().decide(
    ctx({
      plans: [plan('single')],
      tasks: [task({ originRef: 'issue:12:plan', branch: 'plan/issue/12', title: 'Plan issue #12' })],
    }),
  );
  assert.deepEqual(origins(actions), ['issue:12'], 'a plan that says "one PR will do" releases the work');
});

test('once the single PR has been worked, the assessor gets its turn', async () => {
  // The other half: the fix must not cost the assessor the case it exists for. A
  // pickup agent ran and its PR left the open world, so the question is live again.
  const { actions } = await planningAssessor().decide(
    ctx({
      plans: [plan('single')],
      tasks: [task({ originRef: 'issue:12:plan', branch: 'plan/issue/12' }), task({ id: 't2', originRef: 'issue:12' })],
    }),
  );
  assert.deepEqual(origins(actions), ['issue:12:assess']);
});

// -- suppression -------------------------------------------------------------

test('assess and pickup never both fire for one issue', async () => {
  const { actions } = await assessor().decide(ctx());
  const dispatched = origins(actions);
  assert.equal(dispatched.filter((o) => o.startsWith('issue:12')).length, 1, 'one agent on the issue, not two');
  assert.ok(!dispatched.includes('issue:12'), 'the assessor suppresses the pickup it ranks ahead of');
});

// -- standing down -----------------------------------------------------------

test('an open PR means the answer is not yet knowable', async () => {
  const world = {
    takenAt: NOW,
    pullRequests: [
      { id: 'p', number: 40, title: 'X', branch: 'issue/12', ciStatus: 'passing' as const, unresolvedComments: [] },
    ],
    issues: [issue()],
  };
  const { actions } = await assessor().decide(ctx({ world }));
  assert.ok(!origins(actions).includes('issue:12:assess'));
});

test('anything live under the issue stands the assessor down', async () => {
  for (const live of ['issue:12', 'issue:12:plan', 'issue:12:part:schema']) {
    const { actions } = await assessor().decide(
      ctx({ tasks: [task(), task({ id: 't2', originRef: live, status: 'running' })] }),
    );
    assert.ok(!origins(actions).includes('issue:12:assess'), `${live} is in flight, so nothing is settled`);
  }
});

test('a plan that still schedules something owns the issue', async () => {
  for (const status of ['planning', 'active', 'awaiting_approval'] as const) {
    const { actions } = await assessor().decide(ctx({ plans: [plan(status)] }));
    assert.ok(!origins(actions).includes('issue:12:assess'), `a ${status} plan is not a finished one`);
  }
  // A complete plan schedules nothing further, so the issue is assessable.
  const done = await assessor().decide(ctx({ plans: [plan('complete')] }));
  assert.ok(origins(done.actions).includes('issue:12:assess'));
});

test('a standing verdict is not re-assessed', async () => {
  const delivery: IssueDelivery = {
    originRef: 'issue:12',
    summary: 'PR #40 delivered it',
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  };
  const { actions } = await assessor().decide(ctx({ deliveries: [delivery] }));
  assert.deepEqual(origins(actions), [], 'parked, and not re-asked either');
});

test('the watch gate applies, evaluated once on the issue', async () => {
  const d = new RuleDispatcher({ watchLabel: 'agent-ready' }, {}, undefined, 'main', {}, { enabled: true });

  const unwatched = await d.decide(ctx());
  assert.deepEqual(origins(unwatched.actions), [], 'opt-in: an untagged issue is left alone');

  const watched = await d.decide(
    ctx({ world: { takenAt: NOW, pullRequests: [], issues: [issue({ labels: ['agent-ready'] })] } }),
  );
  assert.deepEqual(origins(watched.actions), ['issue:12:assess']);
});

// -- failing open ------------------------------------------------------------

test('a spent attempt cap returns the issue to ordinary pickup, with no escalation', async () => {
  // Narrowing rule 4 without this turns any assessor crash into a permanently
  // parked issue — the planner's fail-open, for the planner's reason.
  const attempt = (i: number): Decision => ({
    id: `d${i}`,
    cycleId: `c${i}`,
    action: {
      type: 'dispatch_code_agent',
      branch: 'assess/issue/12',
      title: 'Assess issue #12',
      prompt: 'x',
      originRef: 'issue:12:assess',
      reason: 'assessing',
    },
    outcome: 'executed',
    rule: 'issue-assess',
    admission: null,
    detail: '',
    createdAt: '2026-07-27T00:00:00.000Z',
  });
  const spent = [attempt(1), attempt(2), attempt(3)];

  const { actions } = await assessor().decide(ctx({ recentDecisions: spent }));
  assert.deepEqual(origins(actions), ['issue:12'], 'the issue falls back to pickup');
  assert.ok(
    !actions.some((a) => a.type === 'escalate_to_human'),
    'no escalation: there is nothing a human can do about an assessment that did not happen',
  );
});

test('a cooling assessor still suppresses pickup for that cycle, and stays visible', async () => {
  const recent: Decision[] = [
    {
      id: 'd1',
      cycleId: 'c1',
      action: {
        type: 'dispatch_code_agent',
        branch: 'assess/issue/12',
        title: 'Assess issue #12',
        prompt: 'x',
        originRef: 'issue:12:assess',
        reason: 'assessing',
      },
      outcome: 'executed',
      rule: 'issue-assess',
      admission: null,
      detail: '',
      // Inside the 15-minute cooldown window.
      createdAt: '2026-07-28T11:55:00.000Z',
    },
  ];
  const { actions, upcoming } = await assessor().decide(ctx({ recentDecisions: recent }));

  assert.deepEqual(origins(actions), [], 'cooling, so nothing is dispatched');
  const queued = upcoming?.find((i) => i.origin === 'issue:12:assess');
  assert.equal(queued?.status, 'cooldown', 'kept visible rather than silently skipped');
});

// -- the tool, through the same dispatch an agent's bridge reaches ------------

function testConfig(): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-assess-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
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
    branch: 'assess/issue/12',
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

test('assess_issue is advertised under its name in the allow-list', () => {
  assert.ok(MCP_TOOL_NAMES.includes('assess_issue'), 'a tool missing from names.ts connects but is never callable');
});

test('a delivered verdict parks the issue, attributed from the credential', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assess');
  const res = await callTool(system, agent, 'assess_issue', {
    status: 'delivered',
    summary: 'PR #40 (observed merged) adds the endpoint and its tests; nothing in the issue is missing',
  });
  assert.equal(res.isError, false);

  const delivery = system.store.getDelivery('issue:12');
  assert.equal(delivery?.by, 'assessor');
  assert.equal(delivery?.agentId, agent.id, 'attribution is structural — the tool takes no issue argument');
  assert.match(res.text, /not closed|stays a human decision/, 'the agent must not believe it closed the ticket');
  system.store.close?.();
});

test('a more_work verdict lands as a shortfall, never in the working agent’s own row', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assess');
  const res = await callTool(system, agent, 'assess_issue', {
    status: 'more_work',
    summary: 'the migration the issue asks for is not in the repository',
  });
  assert.equal(res.isError, false);

  // It used to write `issue_conclusions`, which is keyed on the issue and is the
  // row `conclude_work` writes — so an assessment overwrote the working agent's
  // own declaration, its note and its author, with no precedence between two
  // parties the resolver could not tell apart (issue #159).
  const shortfall = system.store.getShortfall('issue:12');
  assert.equal(shortfall?.by, 'assessor');
  assert.equal(shortfall?.agentId, agent.id, 'attribution is structural — the tool takes no issue argument');
  assert.equal(system.store.getIssueConclusion('issue:12'), null, "the agent's own row is left alone");
  assert.equal(system.store.getDelivery('issue:12'), null, 'and the park is not written');
  system.store.close?.();
});

test('the two verdicts clear each other, so an issue never carries both', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assess');

  await callTool(system, agent, 'assess_issue', { status: 'delivered', summary: 'all present' });
  await callTool(system, agent, 'assess_issue', { status: 'more_work', summary: 'actually the CLI half is missing' });
  assert.equal(system.store.getDelivery('issue:12'), null);
  assert.ok(system.store.getShortfall('issue:12'));

  await callTool(system, agent, 'assess_issue', { status: 'delivered', summary: 'the CLI half landed in PR #41' });
  assert.equal(system.store.getShortfall('issue:12'), null);
  assert.ok(system.store.getDelivery('issue:12'));
  system.store.close?.();
});

test('an agent that did the work cannot assess it, and is told which tool is its own', async () => {
  const system = build();
  for (const origin of ['issue:12', 'issue:12:plan', 'issue:12:part:schema']) {
    const agent = spawnAgent(system, origin);
    const res = await callTool(system, agent, 'assess_issue', { status: 'delivered', summary: 'looks fine to me' });
    assert.equal(res.isError, true, `${origin} is doing the work, so judging it is not an assessment`);
    assert.match(res.text, /conclude_work/, 'refusals name the tool that is theirs');
  }
  assert.equal(system.store.getDelivery('issue:12'), null, 'and nothing is written');
  system.store.close?.();
});

test('an assessor is pointed at assess_issue when it reaches for conclude_work', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assess');
  const res = await callTool(system, agent, 'conclude_work', { status: 'done', note: 'it is finished' });
  assert.equal(res.isError, true);
  assert.match(res.text, /assess_issue/);
  system.store.close?.();
});

test('a rejected assessment writes nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assess');

  const noSummary = await callTool(system, agent, 'assess_issue', { status: 'delivered', summary: '  ' });
  assert.equal(noSummary.isError, true, 'a bare verdict is not reviewable');

  const badVerdict = await callTool(system, agent, 'assess_issue', { status: 'done', summary: 'x' });
  assert.equal(badVerdict.isError, true, '"done" is conclude_work\'s word, not this one');

  assert.equal(system.store.getDelivery('issue:12'), null);
  assert.equal(system.store.getIssueConclusion('issue:12'), null);
  system.store.close?.();
});

// -- the graph reaches the agent ---------------------------------------------

test('world_read carries the work subtree, including a PR the world has forgotten', async () => {
  const system = build();
  // A merged PR that has aged out of `closedPullRequests` entirely — the case the
  // durable record exists for, and the one the assessor most needs.
  system.store.recordWorkGraph([
    { ref: 'issue:12', kind: 'issue', parentRef: null, title: 'Add the thing', status: 'open', terminal: false },
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      title: 'Add the thing',
      status: 'merged',
      terminal: true,
      provenance: 'observed',
    },
  ]);
  system.store.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    issues: [issue()],
  });

  const agent = spawnAgent(system, 'issue:12:assess');
  // The origin ref passes back verbatim: `world_read` is suffix-tolerant.
  const res = await callTool(system, agent, 'world_read', { kind: 'issue', ref: 'issue:12:assess' });
  assert.equal(res.isError, false);

  const payload = JSON.parse(res.text) as { item: { work?: { ref: string; provenance: string | null }[] } };
  const work = payload.item.work ?? [];
  const pr = work.find((n) => n.ref === 'pr:40');
  assert.ok(pr, 'the PR that delivered the issue is reachable even though the world has forgotten it');
  assert.equal(pr.provenance, 'observed', 'the assessor must be able to weigh watched against assumed');
  system.store.close?.();
});

test('an assessment appears in the graph under its issue, and is never terminal', () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assess');
  const t = system.store.getTask(system.store.getAgent(agent.id)!.taskId)!;

  const nodes = foldWorkGraph({
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [t],
    plans: [],
    parts: [],
    jobs: [],
    filings: [],
    existing: [],
  });

  const node = nodes.find((n) => n.ref === 'issue:12:assess');
  assert.ok(node, 'the `assess` kind stage 1 reserved is now written');
  assert.equal(node.kind, 'assess');
  assert.equal(node.parentRef, 'issue:12', 'an assessment is about the issue, not about what delivered it');
  assert.equal(node.terminal, false, 'terminality here would be the graph holding an opinion about completion');
  system.store.close?.();
});

// -- the operator's arm ------------------------------------------------------

test('the operator can park an issue and release it again', async () => {
  const system = build();
  const app = await buildApp(system);

  const parked = await app.app.inject({
    method: 'POST',
    url: '/api/issues/12/delivered',
    payload: { delivered: true, summary: 'checked it myself' },
  });
  assert.equal(parked.statusCode, 200);
  const row = system.store.getDelivery('issue:12');
  assert.equal(row?.by, 'operator');
  assert.equal(row?.summary, 'checked it myself');

  const released = await app.app.inject({
    method: 'POST',
    url: '/api/issues/12/delivered',
    payload: { delivered: false },
  });
  assert.equal(released.statusCode, 200);
  assert.equal(system.store.getDelivery('issue:12'), null, 'clearing is a delete, not a stored "not delivered"');

  await app.app.close();
  system.store.close?.();
});

test('the route refuses a body it cannot act on', async () => {
  const system = build();
  const app = await buildApp(system);

  const bad = await app.app.inject({ method: 'POST', url: '/api/issues/12/delivered', payload: {} });
  assert.equal(bad.statusCode, 400);
  const badNumber = await app.app.inject({
    method: 'POST',
    url: '/api/issues/abc/delivered',
    payload: { delivered: true },
  });
  assert.equal(badNumber.statusCode, 400);

  await app.app.close();
  system.store.close?.();
});
