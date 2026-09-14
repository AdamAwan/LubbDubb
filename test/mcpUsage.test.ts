import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpInsights } from '../src/insights/mcpInsights.js';
import { resolveWindow, sinceOrEpoch, type InsightsWindow } from '../src/insights/insightsWindow.js';
import { Store } from '../src/store/store.js';
import { DEFAULT_MCP_ARGS_RETENTION_DAYS } from '../src/store/mcpCalls.js';
import { RETIRED_TOOL_NAMES } from '../src/mcp/names.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent, McpCall, TaskSummary } from '../src/types.js';

const T = '2026-08-04T09:00:00.000Z';
const NOW = Date.parse('2026-08-04T12:00:00.000Z');

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'done',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function task(id: string, originRef: string | null, over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: `task_${id}`,
    kind: 'code',
    title: `Task ${id}`,
    branch: null,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: id,
    createdAt: T,
    updatedAt: T,
    ...over,
  } as TaskSummary;
}

function call(over: Partial<McpCall> = {}): McpCall {
  return {
    id: `mcp_${Math.random().toString(36).slice(2)}`,
    channel: 'fleet',
    tool: 'note_progress',
    agentId: 'a1',
    taskId: 'task_a1',
    originRef: 'issue:12',
    ok: true,
    error: null,
    durationMs: 4,
    args: null,
    argsBytes: 0,
    argsDropped: false,
    createdAt: T,
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildMcpInsights>[0]> = {}) {
  const callsEverByAgent = new Map<string, number>();
  for (const call of over.calls ?? []) {
    if (call.agentId === null) continue;
    callsEverByAgent.set(call.agentId, (callsEverByAgent.get(call.agentId) ?? 0) + 1);
  }
  return buildMcpInsights({
    calls: [],
    agents: [],
    tasks: [],
    namedInPrompts: new Map(),
    lastCallByTool: new Map(),
    callsEverByAgent,
    claudeArgs: [],
    window: resolveWindow('7d', NOW, null),
    now: NOW,
    ...over,
  });
}

test('a tool the addendum names and nobody called is "named, never reached for"', () => {
  const insights = build({
    calls: [call({ tool: 'note_progress' })],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  const verdict = insights.quiet.find((q) => q.tool === 'world_read');
  assert.equal(verdict?.verdict, 'named-never-called');
  assert.equal(verdict?.namedInAddendum, true, 'the evidence is the addendum text, not the classification');
});

test('a tool nothing names at all is "nothing named it", which is the finding', () => {
  const insights = build({ calls: [call()], agents: [agent('a1')], tasks: [task('a1', 'issue:12')] });
  const verdict = insights.quiet.find((q) => q.tool === 'conclude_work');
  assert.equal(verdict?.verdict, 'never-named');
  assert.equal(verdict?.namedInAddendum, false);
  assert.equal(verdict?.namedInPrompts, 0);
});

test('the same tool, once a dispatch prompt names it, stops being a finding', () => {
  const insights = build({
    calls: [call()],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
    namedInPrompts: new Map([['conclude_work', 3]]),
  });
  const verdict = insights.quiet.find((q) => q.tool === 'conclude_work');
  assert.equal(verdict?.verdict, 'named-never-called');
  assert.equal(verdict?.namedInPrompts, 3);
});

test('a tool that is called and refused every time is not silent, and is still reported', () => {
  const insights = build({
    calls: [
      call({ tool: 'report_remedy', ok: false, error: 'guard must be one of local_check, documented' }),
      call({ tool: 'report_remedy', ok: false, error: 'guard must be one of local_check, documented' }),
    ],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  const verdict = insights.quiet.find((q) => q.tool === 'report_remedy');
  assert.equal(verdict?.verdict, 'always-refused');
  assert.equal(verdict?.refused, 2);
  assert.match(verdict?.lastRefusal ?? '', /guard must be one of/);
});

test('one success is enough to stop a tool being reported at all', () => {
  const insights = build({
    calls: [call({ tool: 'open_pr', ok: false, error: 'no commits' }), call({ tool: 'open_pr' })],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(
    insights.quiet.find((q) => q.tool === 'open_pr'),
    undefined,
  );
});

test('a retired name being called is a finding, and it is not otherwise listed', () => {
  const quiet = build({ agents: [agent('a1')], tasks: [task('a1', 'issue:12')] }).quiet;
  assert.equal(
    quiet.find((q) => q.tool === 'report_finding'),
    undefined,
    'a retired name nothing calls is not a finding',
  );

  const called = build({
    calls: [call({ tool: 'report_finding', ok: false, error: 'report_finding has been retired' })],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  const verdict = called.quiet.find((q) => q.tool === 'report_finding');
  assert.equal(verdict?.verdict, 'retired');
  assert.match(verdict?.remedy ?? '', /raise/);
});

test('a desktop tool nobody used is a reading, not a fault, and carries no remedy', () => {
  const verdict = build().quiet.find((q) => q.tool === 'local_run');
  assert.equal(verdict?.verdict, 'desktop-unused');
  assert.equal(verdict?.remedy, null);
});

test('the verdicts are ordered by what wants doing about them', () => {
  const insights = build({
    calls: [
      call({ tool: 'report_remedy', ok: false, error: 'refused' }),
      call({ tool: 'report_finding', ok: false, error: 'retired' }),
    ],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  const order = insights.quiet.map((q) => q.verdict);
  assert.equal(order[0], 'always-refused');
  assert.equal(order[1], 'retired');
  assert.ok(order.indexOf('never-named') < order.indexOf('desktop-unused'));
});

test('a settled run that called nothing is counted, with the profile that explains it', () => {
  const insights = build({
    calls: [call({ agentId: 'a1' })],
    agents: [agent('a1'), agent('a2'), agent('a3')],
    tasks: [
      task('a1', 'issue:12'),
      task('a2', 'issue:14', { profile: 'reviewer-fast' } as Partial<TaskSummary>),
      task('a3', 'pr:42:ci'),
    ],
  });
  assert.equal(insights.totals.runs, 3);
  assert.equal(insights.totals.silentRuns, 2);
  assert.deepEqual(insights.silentRuns.map((r) => r.agentId).sort(), ['a2', 'a3']);
  assert.equal(insights.silentRuns.find((r) => r.agentId === 'a2')?.profile, 'reviewer-fast');
  assert.equal(insights.byPhase.find((p) => p.phase === 'ci')?.silentRuns, 1);
});

test('a run still out is not a silent run', () => {
  const insights = build({
    agents: [agent('a1', { endedAt: null, status: 'running' })],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(insights.totals.runs, 0);
  assert.equal(insights.totals.silentRuns, 0);
});

test('the operator --allowedTools override is reported before it costs a run', () => {
  assert.equal(build({ claudeArgs: ['--verbose'] }).allowedToolsOverridden, false);
  assert.equal(build({ claudeArgs: ['--allowedTools', 'Bash(git:*)'] }).allowedToolsOverridden, true);
  assert.equal(build({ claudeArgs: ['--allowedTools=Bash(git:*)'] }).allowedToolsOverridden, true);
});

test('the channels are counted apart and never summed', () => {
  const insights = build({
    calls: [
      call({ channel: 'fleet', tool: 'validation_report' }),
      call({ channel: 'desktop', tool: 'validation_report', agentId: null, taskId: null, originRef: null }),
      call({ channel: 'desktop', tool: 'validation_read', agentId: null, taskId: null, originRef: null }),
    ],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(insights.totals.calls, 1, 'the headline is the fleet channel, not both');
  assert.equal(insights.channels.find((c) => c.channel === 'fleet')?.calls, 1);
  assert.equal(insights.channels.find((c) => c.channel === 'desktop')?.calls, 2);
  const rows = insights.tools.filter((t) => t.tool === 'validation_report');
  assert.deepEqual(rows.map((r) => r.channel).sort(), ['desktop', 'fleet']);
});

test('a call with no identity behind it is still counted, and files under no phase', () => {
  const insights = build({
    calls: [
      call({ agentId: null, taskId: null, originRef: null, ok: false, error: 'unknown or revoked agent credential' }),
    ],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(insights.totals.calls, 1);
  assert.equal(insights.totals.refused, 1);
  assert.equal(insights.byPhase.find((p) => p.phase === 'other')?.calls, 1);
});

test('a call is filed under the origin it carried, not the one its task has now', () => {
  const insights = build({
    calls: [call({ agentId: 'a1', originRef: 'pr:42:ci' })],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(insights.byPhase.find((p) => p.phase === 'ci')?.calls, 1);
  assert.equal(insights.byPhase.find((p) => p.phase === 'build')?.calls, 0);
});

test('compaction clears the arguments and keeps the row', () => {
  const store = new Store(':memory:');
  const old = '2026-07-01T09:00:00.000Z';
  store.mcpCalls.recordMcpCall(
    {
      channel: 'fleet',
      tool: 'plan_submit',
      agentId: 'a1',
      taskId: 't1',
      originRef: 'issue:12',
      ok: true,
      error: null,
      durationMs: 9,
      args: { verdict: 'plan', parts: ['one'] },
    },
    DEFAULT_MCP_ARGS_RETENTION_DAYS,
  );
  const before = store.mcpCalls.listMcpCallsSince(old)[0]!;
  assert.ok(before.args, 'the arguments are recorded');
  assert.ok(before.argsBytes > 0);

  assert.equal(store.mcpCalls.compactMcpCallArgs(0), 1);
  const after = store.mcpCalls.listMcpCallsSince(old)[0]!;
  assert.equal(after.args, null);
  assert.equal(after.argsDropped, true, 'compacted is a different fact from "carried none"');
  assert.equal(after.argsBytes, before.argsBytes);
  assert.equal(store.mcpCalls.listMcpCallsSince(old).length, 1, 'the row itself is never dropped');
  store.close();
});

test('a call that carried no arguments is not mistaken for a compacted one', () => {
  const store = new Store(':memory:');
  store.mcpCalls.recordMcpCall(
    {
      channel: 'fleet',
      tool: 'scratch_read',
      agentId: 'a1',
      taskId: 't1',
      originRef: null,
      ok: true,
      error: null,
      durationMs: 2,
      args: {},
    },
    14,
  );
  const row = store.mcpCalls.listMcpCallsSince('2026-01-01T00:00:00.000Z')[0]!;
  assert.equal(row.args, null);
  assert.equal(row.argsDropped, false);
  assert.equal(row.argsBytes, 0);
  store.close();
});

test('a retention of zero records no arguments in the first place', () => {
  const store = new Store(':memory:');
  store.mcpCalls.recordMcpCall(
    {
      channel: 'fleet',
      tool: 'raise',
      agentId: 'a1',
      taskId: 't1',
      originRef: null,
      ok: true,
      error: null,
      durationMs: 3,
      args: { claim: 'secret' },
    },
    0,
  );
  const row = store.mcpCalls.listMcpCallsSince('2026-01-01T00:00:00.000Z')[0]!;
  assert.equal(row.args, null);
  assert.ok(row.argsBytes > 0);
  store.close();
});

test('the last call per tool is answered over all time, not over a window', () => {
  const store = new Store(':memory:');
  store.mcpCalls.recordMcpCall(
    {
      channel: 'fleet',
      tool: 'escalate',
      agentId: 'a1',
      taskId: 't1',
      originRef: null,
      ok: true,
      error: null,
      durationMs: 1,
      args: {},
    },
    14,
  );
  const last = store.mcpCalls.lastMcpCallByTool();
  assert.ok(last.get('fleet:escalate'));
  assert.equal(last.get('fleet:open_pr'), undefined, 'a tool never called is absent rather than null');
  store.close();
});

test('no per-tool figure on one channel is taken from the other', () => {
  for (const caller of ['fleet', 'desktop'] as const) {
    const other = caller === 'fleet' ? 'desktop' : 'fleet';
    const store = new Store(':memory:');
    store.mcpCalls.recordMcpCall(
      {
        channel: caller,
        tool: 'validation_report',
        agentId: caller === 'fleet' ? 'a1' : null,
        taskId: null,
        originRef: null,
        ok: true,
        error: null,
        durationMs: 3,
        args: {},
      },
      14,
    );
    const last = store.mcpCalls.lastMcpCallByTool();
    assert.ok(last.get(`${caller}:validation_report`), `${caller} keeps its own last call`);
    assert.equal(last.get(`${other}:validation_report`), undefined, `${other} never called it`);

    const insights = buildMcpInsights({
      calls: store.mcpCalls.listMcpCallsSince('1970-01-01T00:00:00.000Z'),
      agents: [],
      tasks: [],
      namedInPrompts: new Map(),
      lastCallByTool: last,
      callsEverByAgent: store.mcpCalls.countMcpCallsByAgent(),
      claudeArgs: [],
      window: resolveWindow('7d', NOW, null),
      now: NOW,
    });
    const rows = insights.tools.filter((t) => t.tool === 'validation_report');
    assert.equal(rows.length, 2, 'one row per channel, since the name is on both');
    for (const row of rows) {
      if (row.channel === caller) {
        assert.ok(row.lastCalledAt, 'the channel that called it has the date');
        assert.equal(row.calls, 1);
      } else {
        assert.equal(row.lastCalledAt, null, "and the channel that did not has nothing — not the other's date");
        assert.equal(row.calls, 0);
      }
    }
    store.close();
  }
});

test('a tool call an agent makes is recorded, and a refusal is recorded with its reason', async () => {
  const system = testSystem();
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Work',
    prompt: 'do it',
    branch: null,
    originRef: 'issue:12',
  });
  const agentRow = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-mcp-')));
  const session = system.mcp.session(agentRow.id);
  assert.ok(session);

  await session.call('note_progress', { note: 'reading the router' });
  await session.call('plan_submit', {});

  const calls = system.store.mcpCalls.listMcpCallsSince('2000-01-01T00:00:00.000Z');
  assert.deepEqual(
    calls.map((c) => c.tool),
    ['note_progress', 'plan_submit'],
  );
  const [noted, planned] = calls;
  assert.equal(noted!.ok, true);
  assert.equal(noted!.agentId, agentRow.id, 'attribution is the credential’s, never an argument');
  assert.equal(noted!.originRef, 'issue:12');
  assert.equal(planned!.ok, false);
  assert.ok(planned!.error, 'a refusal carries the tool’s own words');
  system.store.close();
});

test('a call to a retired name is answered and recorded rather than lost', async () => {
  const system = testSystem();
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Work',
    prompt: 'do it',
    branch: null,
    originRef: 'issue:12',
  });
  const agentRow = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-mcp-')));
  const session = system.mcp.session(agentRow.id);
  assert.ok(session);

  const res = (await session.call('report_finding', { summary: 'x' })) as { isError?: boolean };
  assert.equal(res.isError, true);

  const [recorded] = system.store.mcpCalls.listMcpCallsSince('2000-01-01T00:00:00.000Z');
  assert.equal(recorded?.tool, 'report_finding');
  assert.equal(recorded?.ok, false);
  assert.match(recorded?.error ?? '', /retired/);
  system.store.close();
});

function testSystem(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-mcpusage-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

test('a window full of retired and never-existed names keeps every fraction a fraction', () => {
  const calls = [
    ...RETIRED_TOOL_NAMES.map((tool) => call({ tool, ok: false, error: 'retired' })),
    call({ tool: 'summon_the_kraken', ok: false, error: 'no such tool' }),
  ];
  const insights = build({ calls, agents: [agent('a1')], tasks: [task('a1', 'issue:12')] });

  assert.ok(RETIRED_TOOL_NAMES.length > 0, 'the fixture needs a retired name to be about anything');
  assert.ok(
    insights.totals.toolsQuiet <= insights.totals.toolsAdvertised,
    `${insights.totals.toolsQuiet}/${insights.totals.toolsAdvertised} is not a reading`,
  );
  assert.equal(
    insights.totals.toolsRetiredCalled,
    RETIRED_TOOL_NAMES.length,
    'a retired name still being called is counted, just not as a live tool gone quiet',
  );
  for (const channel of insights.channels) {
    assert.ok(
      channel.toolsCalled <= channel.toolsAdvertised,
      `${channel.channel} ${channel.toolsCalled}/${channel.toolsAdvertised}`,
    );
  }

  const unknown = insights.naming.find((n) => n.naming === 'unknown');
  assert.ok(unknown, 'a name that was never a tool has a class of its own');
  assert.equal(unknown.calls, 1);
  const shares = insights.naming.reduce((sum, n) => sum + n.calls, 0);
  assert.equal(shares, insights.totals.calls, 'every fleet call is in exactly one naming class');
});

test('the naming classes drop the two rows that are a permanent zero on a healthy deployment', () => {
  const insights = build({ calls: [call({ tool: 'note_progress' })] });
  assert.equal(
    insights.naming.some((n) => n.naming === 'retired' || n.naming === 'unknown'),
    false,
    'nothing called a withdrawn or invented name, so neither row is drawn',
  );
});

test('a run that straddles the window start is not a silent run', () => {
  let clock = Date.parse('2026-08-01T00:00:00.000Z') - 72 * 60 * 60_000;
  const store = new Store(':memory:', () => new Date(clock).toISOString());
  const now = Date.parse('2026-08-01T00:00:00.000Z');

  const long = store.agents.createAgent({ taskId: 'task_long', cwd: '/wt/long', pid: 1 });
  for (let n = 0; n < 3; n += 1)
    store.mcpCalls.recordMcpCall(
      {
        channel: 'fleet',
        tool: 'note_progress',
        agentId: long.id,
        taskId: 'task_long',
        originRef: 'issue:12',
        ok: true,
        error: null,
        durationMs: 4,
        args: {},
      },
      14,
    );
  clock = now - 60 * 60_000;
  store.agents.updateAgent(long.id, { status: 'done', endedAt: new Date(clock).toISOString() });

  const mute = store.agents.createAgent({ taskId: 'task_mute', cwd: '/wt/mute', pid: 2 });
  store.agents.updateAgent(mute.id, { status: 'done', endedAt: new Date(clock).toISOString() });

  const insights = (window: InsightsWindow) =>
    buildMcpInsights({
      calls: store.mcpCalls.listMcpCallsSince(sinceOrEpoch(resolveWindow(window, now, null).since)),
      agents: store.agents.listAgents(),
      tasks: [task('task_long', 'issue:12'), task('task_mute', 'issue:13')],
      namedInPrompts: new Map(),
      lastCallByTool: store.mcpCalls.lastMcpCallByTool(),
      callsEverByAgent: store.mcpCalls.countMcpCallsByAgent(),
      claudeArgs: [],
      window: resolveWindow(window, now, null),
      now,
    });

  for (const window of ['24h', '7d'] as const) {
    const view = insights(window);
    assert.equal(view.totals.runs, 2, `${window}: both runs settled inside it`);
    assert.deepEqual(
      view.silentRuns.map((r) => r.agentId),
      [mute.id],
      `${window}: the straddling run called the channel — whenever it called`,
    );
    assert.equal(view.totals.silentRuns, 1);
    assert.deepEqual(
      view.byPhase.filter((p) => p.silentRuns > 0).map((p) => p.silentRuns),
      [1],
      `${window}: the phase table counts the same silence the headline does`,
    );
  }

  assert.equal(insights('24h').totals.calls, 0);
  assert.equal(insights('7d').totals.calls, 3);
  store.close();
});
