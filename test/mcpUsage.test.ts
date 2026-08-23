import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpInsights } from '../src/mcpInsights.js';
import { resolveWindow, sinceOrEpoch } from '../src/insightsWindow.js';
import { Store } from '../src/store/store.js';
import { DEFAULT_MCP_ARGS_RETENTION_DAYS } from '../src/store/mcpCalls.js';
import { RETIRED_TOOL_NAMES } from '../src/mcp/names.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent, McpCall, TaskSummary } from '../src/types.js';

/**
 * The MCP usage reading, and the one thing it has to get right.
 *
 * The arithmetic is a sum. What is load-bearing is the **verdict**: a count of
 * zero is four different facts wearing one face, and the tab exists to say which.
 * A reading that told an operator "nothing named it" about a tool the addendum
 * names would send them to edit a prompt that is already correct — and one that
 * said "named, never reached for" about a tool no prompt mentions would hide the
 * only thing they could actually fix.
 *
 * So the tests below are mostly about the ladder, plus the two things it rests
 * on: that a run which called nothing is counted as a run, and that the two
 * channels are never summed.
 */

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
  // The all-time count, defaulted off whatever calls the case supplies — which is
  // what a fixture stamped at one clock instant means. A case about a run whose
  // calls fall *outside* the window passes it explicitly.
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
    window: resolveWindow('7d', NOW),
    now: NOW,
    ...over,
  });
}

// -- the verdict ladder -------------------------------------------------------

test('a tool the addendum names and nobody called is "named, never reached for"', () => {
  // The distinction the operator acts on: the channel worked, the agents were
  // told, and none of them wanted it. Nothing to fix in a prompt.
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
  // `conclude_work` is classified `point-of-use`, so the addendum deliberately
  // does not name it — and if no dispatch prompt in the window did either, no
  // agent was ever told it exists. Being in `tools/list` is not being told, and
  // this is the one verdict here that names a defect rather than a state.
  const insights = build({ calls: [call()], agents: [agent('a1')], tasks: [task('a1', 'issue:12')] });
  const verdict = insights.quiet.find((q) => q.tool === 'conclude_work');
  assert.equal(verdict?.verdict, 'never-named');
  assert.equal(verdict?.namedInAddendum, false);
  assert.equal(verdict?.namedInPrompts, 0);
});

test('the same tool, once a dispatch prompt names it, stops being a finding', () => {
  // The half that keeps the verdict honest: `TOOL_NAMING` says where a tool is
  // *supposed* to be named, and the prompts say whether it was. A check of the
  // classification alone would call this case a defect for ever.
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
  // The tool's own words, because "a tool is refusing everything" is not
  // actionable and "guard must be one of…" is.
  assert.match(verdict?.lastRefusal ?? '', /guard must be one of/);
});

test('one success is enough to stop a tool being reported at all', () => {
  // The ladder is about tools with something to answer for. A tool that mostly
  // works has nothing to answer for here, and listing it would bury the four that do.
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
  // A retired tool nothing calls is the expected state and earns no row. One that
  // is *still being called* is a prompt override nobody has caught up with, and
  // every call to it spends a turn on a refusal.
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
  // Its silence says a person did not sit down and run one, which is not
  // something to fix — and a remedy attached to it would teach an operator to
  // ignore the four verdicts that do carry one.
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

// -- the alarm ----------------------------------------------------------------

test('a settled run that called nothing is counted, with the profile that explains it', () => {
  // The failure the tab is built around, and the reason the fold needs the agent
  // rows at all: a run that reached the channel and was refused everything makes
  // *no row*, so its silence is only visible against the runs that existed.
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
  // Filed under the phase, so "every silent run this week was a CI agent" is a
  // sentence the by-phase table can make.
  assert.equal(insights.byPhase.find((p) => p.phase === 'ci')?.silentRuns, 1);
});

test('a run still out is not a silent run', () => {
  // A run that has not finished has not finished calling things, and counting it
  // would make every busy fleet look broken.
  const insights = build({
    agents: [agent('a1', { endedAt: null, status: 'running' })],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(insights.totals.runs, 0);
  assert.equal(insights.totals.silentRuns, 0);
});

test('the operator --allowedTools override is reported before it costs a run', () => {
  // A live config read rather than a fold, and the only one on the payload: the
  // point is to catch the flag before the first silent run, not to explain one
  // afterwards.
  assert.equal(build({ claudeArgs: ['--verbose'] }).allowedToolsOverridden, false);
  assert.equal(build({ claudeArgs: ['--allowedTools', 'Bash(git:*)'] }).allowedToolsOverridden, true);
  // The `=` form wins over ours exactly the same way, so it must read the same way.
  assert.equal(build({ claudeArgs: ['--allowedTools=Bash(git:*)'] }).allowedToolsOverridden, true);
});

// -- the two channels ---------------------------------------------------------

test('the channels are counted apart and never summed', () => {
  // They are different credentials over different tool sets, and
  // `validation_report` is two different tools with one name — so a total across
  // them would be a number about nothing.
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
  // One name, two rows — because they are two tools.
  const rows = insights.tools.filter((t) => t.tool === 'validation_report');
  assert.deepEqual(rows.map((r) => r.channel).sort(), ['desktop', 'fleet']);
});

test('a call with no identity behind it is still counted, and files under no phase', () => {
  // The refusal an unresolvable credential gets is a real answer to a real call,
  // and it is the shape of the failure this whole reading is for.
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
  // The ref is copied onto the row at call time for exactly this: a task
  // retargeted later would otherwise silently re-file every call it ever made
  // under a different phase.
  const insights = build({
    calls: [call({ agentId: 'a1', originRef: 'pr:42:ci' })],
    agents: [agent('a1')],
    tasks: [task('a1', 'issue:12')],
  });
  assert.equal(insights.byPhase.find((p) => p.phase === 'ci')?.calls, 1);
  assert.equal(insights.byPhase.find((p) => p.phase === 'build')?.calls, 0);
});

// -- the store ----------------------------------------------------------------

test('compaction clears the arguments and keeps the row', () => {
  // The whole shape of the retention decision: a count stays exact at every
  // window the page offers, and only the unbounded part goes.
  const store = new Store(':memory:');
  const old = '2026-07-01T09:00:00.000Z';
  store.recordMcpCall(
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
  const before = store.listMcpCallsSince(old)[0]!;
  assert.ok(before.args, 'the arguments are recorded');
  assert.ok(before.argsBytes > 0);

  // A retention of zero clears everything, which is what makes turning the
  // setting off retroactive rather than merely prospective.
  assert.equal(store.compactMcpCallArgs(0), 1);
  const after = store.listMcpCallsSince(old)[0]!;
  assert.equal(after.args, null);
  assert.equal(after.argsDropped, true, 'compacted is a different fact from "carried none"');
  // The reading survives the text.
  assert.equal(after.argsBytes, before.argsBytes);
  assert.equal(store.listMcpCallsSince(old).length, 1, 'the row itself is never dropped');
  store.close();
});

test('a call that carried no arguments is not mistaken for a compacted one', () => {
  // Both are `args IS NULL`, and reading them the same way would report a
  // fortnight of empty calls — believably.
  const store = new Store(':memory:');
  store.recordMcpCall(
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
  const row = store.listMcpCallsSince('2026-01-01T00:00:00.000Z')[0]!;
  assert.equal(row.args, null);
  assert.equal(row.argsDropped, false);
  assert.equal(row.argsBytes, 0);
  store.close();
});

test('a retention of zero records no arguments in the first place', () => {
  // The setting is the off switch; the sweep is not. A deployment that does not
  // want agent arguments on disk must never have them on disk.
  const store = new Store(':memory:');
  store.recordMcpCall(
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
  const row = store.listMcpCallsSince('2026-01-01T00:00:00.000Z')[0]!;
  assert.equal(row.args, null);
  // The size is still measured, so the tab can say how big calls are on a
  // deployment that keeps none of them.
  assert.ok(row.argsBytes > 0);
  store.close();
});

test('the last call per tool is answered over all time, not over a window', () => {
  // The most useful sentence about a silent tool is "nothing called it this week,
  // and the last call was nineteen days ago" — a date the window cannot contain.
  const store = new Store(':memory:');
  store.recordMcpCall(
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
  const last = store.lastMcpCallByTool();
  assert.ok(last.get('fleet:escalate'));
  assert.equal(last.get('fleet:open_pr'), undefined, 'a tool never called is absent rather than null');
  store.close();
});

// #533 — `validation_report` is the one name on both channels, so it is the one
// name whose two rows can disagree, and the only place a per-tool figure can be
// taken from the wrong channel.
test('no per-tool figure on one channel is taken from the other', () => {
  for (const caller of ['fleet', 'desktop'] as const) {
    const other = caller === 'fleet' ? 'desktop' : 'fleet';
    const store = new Store(':memory:');
    store.recordMcpCall(
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
    const last = store.lastMcpCallByTool();
    assert.ok(last.get(`${caller}:validation_report`), `${caller} keeps its own last call`);
    assert.equal(last.get(`${other}:validation_report`), undefined, `${other} never called it`);

    const insights = buildMcpInsights({
      calls: store.listMcpCallsSince('1970-01-01T00:00:00.000Z'),
      agents: [],
      tasks: [],
      namedInPrompts: new Map(),
      lastCallByTool: last,
      callsEverByAgent: store.countMcpCallsByAgent(),
      claudeArgs: [],
      window: resolveWindow('7d', NOW),
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

// -- end to end ---------------------------------------------------------------

test('a tool call an agent makes is recorded, and a refusal is recorded with its reason', async () => {
  // Through the same entry point an agent's bridge reaches, so there is no
  // test-only recording path.
  const system = testSystem();
  const task = system.store.createTask({
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

  const calls = system.store.listMcpCallsSince('2000-01-01T00:00:00.000Z');
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
  // The whole reason the four names outlived their implementations: deleted
  // outright, this call would come back as an unknown method — a broken channel
  // to the agent, and nothing to anybody watching.
  const system = testSystem();
  const task = system.store.createTask({
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

  const [recorded] = system.store.listMcpCallsSince('2000-01-01T00:00:00.000Z');
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

// #536 — the tile draws `toolsQuiet` over `toolsAdvertised`, so the two must
// count the same set. Written as invariants rather than expected numbers, so a
// tool being added does not rewrite the test.
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

  // And the traffic that belongs to no advertised row is stated rather than
  // quietly missing from the shares.
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
  // The alarm is drawn above every table because it invalidates the others, so a
  // false positive is expensive: it tells the operator not to believe the page,
  // and hands them the full "check this profile's `claudeArgs`" remedy for a
  // grant problem that does not exist. Any run alive at the instant the window
  // opens is a candidate, which is up to the concurrency cap's worth of phantoms
  // every time a 24h view is opened.
  let clock = Date.parse('2026-08-01T00:00:00.000Z') - 72 * 60 * 60_000;
  const store = new Store(':memory:', () => new Date(clock).toISOString());
  const now = Date.parse('2026-08-01T00:00:00.000Z');

  // Starts 72h back, makes three calls immediately, ends 1h back.
  const long = store.createAgent({ taskId: 'task_long', cwd: '/wt/long', pid: 1 });
  for (let n = 0; n < 3; n += 1)
    store.recordMcpCall(
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
  store.updateAgent(long.id, { status: 'done', endedAt: new Date(clock).toISOString() });

  // The true positive, in the same fixture so the assertion pins the distinction
  // rather than the number: a run wholly inside the window that called nothing.
  const mute = store.createAgent({ taskId: 'task_mute', cwd: '/wt/mute', pid: 2 });
  store.updateAgent(mute.id, { status: 'done', endedAt: new Date(clock).toISOString() });

  const insights = (window: string) =>
    buildMcpInsights({
      calls: store.listMcpCallsSince(sinceOrEpoch(resolveWindow(window, now).since)),
      agents: store.listAgents(),
      tasks: [task('task_long', 'issue:12'), task('task_mute', 'issue:13')],
      namedInPrompts: new Map(),
      lastCallByTool: store.lastMcpCallByTool(),
      callsEverByAgent: store.countMcpCallsByAgent(),
      claudeArgs: [],
      window: resolveWindow(window, now),
      now,
    });

  for (const window of ['24h', '7d']) {
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

  // And the window readings *are* still window readings: the calls themselves
  // fall outside 24h and inside 7d, which is what makes the asymmetry visible.
  assert.equal(insights('24h').totals.calls, 0);
  assert.equal(insights('7d').totals.calls, 3);
  store.close();
});
