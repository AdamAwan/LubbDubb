import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildViewModel } from '../web/src/view/viewModel.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { failPlanningOpen } from './support/plans.js';

(globalThis as { React?: typeof React }).React = React;

class FakeChild extends EventEmitter implements StreamChild {
  pid = 4242;
  writes: string[] = [];
  ended = false;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = {
    write: (d: string) => this.writes.push(d),
    end: () => {
      this.ended = true;
    },
  } as unknown as NodeJS.WritableStream;

  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  speak(text: string): void {
    this.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  }
  rateLimit(info: Record<string, unknown>): void {
    this.emitLine({
      type: 'rate_limit_event',
      rate_limit_info: info,
      uuid: '9d2e1c4a-0000-4000-8000-00000000fead',
      session_id: 'f0e1d2c3-0000-4000-8000-00000000beef',
    });
  }
  result(subtype = 'success', isError = false): void {
    this.emitLine({
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: 1200,
      duration_api_ms: 900,
      num_turns: 2,
      total_cost_usd: 0.12,
    });
  }
  exit(code: number): void {
    this.emit('exit', code);
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {}
}

const REJECTED = {
  status: 'rejected',
  resetsAt: 1_776_000_000,
  rateLimitType: 'five_hour',
  overageStatus: 'allowed',
  isUsingOverage: false,
};

function rejectedIn(offsetMs: number): Record<string, unknown> {
  return { ...REJECTED, resetsAt: Math.floor((Date.now() + offsetMs) / 1000) };
}

function recordingSpawner(): { spawner: Spawner; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawner, children };
}

function streamConfig(dir: string, patch: Record<string, unknown> = {}): Config {
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    auth: { enabled: false } as never,
    ...patch,
  });
}

async function fleet(issue = 701, patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-limit-'));
  const { spawner, children } = recordingSpawner();
  const system = buildSystem(streamConfig(dir, patch), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: issue, title: 'Add login' });
  failPlanningOpen(system.store, issue);
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  return { system, agent, child: children[0]!, children };
}

test('an exhausted account parks the agent instead of failing it, and settles nothing', async () => {
  const { system, agent, child } = await fleet();
  child.speak('Rebasing onto main.');
  child.rateLimit(REJECTED);
  child.result('error_during_execution', true);

  const row = system.store.getAgent(agent.id)!;
  assert.equal(row.status, 'waiting', 'parked, not failed');
  assert.equal(row.endedAt, null, 'a park is not an ending');
  assert.match(row.waitingReason ?? '', /usage limit/i, 'the reason names the limit');
  assert.match(row.waitingReason ?? '', /five-hour/, 'and which window ran out');
  assert.match(row.waitingReason ?? '', /2026-04-12/, 'and when it comes back');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'waiting', 'the work is still outstanding');
  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id]);
  assert.equal(system.store.listErrors().length, 0, 'nothing failed, so nothing is recorded as a failure');
  assert.equal(system.store.listOpenEscalations().length, 0, 'no question was asked, so nobody is asked one');
  system.store.close();
});

test('the turn-end limit park keeps its resources through the later process exit', async () => {
  const { system, agent, child } = await fleet();
  child.rateLimit(REJECTED);
  child.result('error_during_execution', true);
  child.exit(1);

  const row = system.store.getAgent(agent.id)!;
  assert.equal(row.status, 'waiting', 'still parked after the process is gone');
  assert.equal(row.pid, null, 'and honest about there being no process');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'waiting');
  assert.equal(system.agents.isLive(agent.id), false, 'the dead session is not held open');
  assert.equal(
    system.store.listErrors().filter((e) => e.message.includes('failed')).length,
    0,
    'no "Agent … failed" entry for a limit',
  );
  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id], 'and the park survives the exit');
  system.store.close();
});

test('a process exit before the turn end still sheds the limit park and resumes on the pulse', async () => {
  const { system, agent, child, children } = await fleet();
  child.rateLimit(rejectedIn(-60_000));
  child.exit(1);

  const row = system.store.getAgent(agent.id)!;
  assert.equal(row.status, 'waiting', 'still parked after the process is gone');
  assert.equal(row.pid, null, 'the dead launch was shed');
  assert.equal(system.agents.isLive(agent.id), false, 'the dead session is not held open');
  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id]);

  const before = children.length;
  await system.harness.runCycle('manual');

  assert.equal(children.length, before + 1, 'the expired park reopens a new session');
  assert.equal(system.store.getAgent(agent.id)!.status, 'running');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'running');
  assert.deepEqual(system.agents.limitedAgentIds(), []);
  system.store.close();
});

test('an agent whose process dies with no limit is no park, and fails once resume is spent', async () => {
  const { system, agent, child } = await fleet(701, { agentResumeAttempts: 0 });
  child.speak('Working.');
  child.exit(1);

  assert.equal(system.store.getAgent(agent.id)!.status, 'failed', 'the ordinary crash path is untouched');
  assert.equal(system.agents.limitedAgentIds().length, 0);
  system.store.close();
});

test('a crash with no limit is a resume, not a park', async () => {
  const { system, agent, child } = await fleet();
  child.speak('Working.');
  child.exit(1);

  const row = system.store.getAgent(agent.id)!;
  assert.equal(row.status, 'running', 're-attached rather than settled');
  assert.equal(row.resumeAttempts, 1);
  assert.equal(system.agents.limitedAgentIds().length, 0, 'and nothing about it reads as a limit');
  assert.equal(row.waitingReason, null, 'no park reason on a crash nobody rate-limited');
  system.store.close();
});

test('a warning is not an exhaustion, and a cleared limit un-arms the park', async () => {
  const { system, agent, child } = await fleet(701, { agentStallNudges: 0 });
  child.rateLimit({ status: 'allowed_warning', resetsAt: 1_776_000_000, rateLimitType: 'five_hour', utilization: 0.9 });
  child.result();
  assert.equal(system.agents.limitedAgentIds().length, 0, 'a warning parks nobody');
  assert.match(
    system.store.getAgent(agent.id)!.waitingReason ?? '',
    /without finishing/,
    'the turn ends as the ordinary "stopped without finishing" park',
  );

  const { system: s2, agent: a2, child: c2 } = await fleet(702, { agentStallNudges: 0 });
  c2.rateLimit(REJECTED);
  c2.rateLimit({ ...REJECTED, status: 'allowed' });
  c2.result();
  assert.equal(s2.agents.limitedAgentIds().length, 0, 'a limit that came back is not a park');
  assert.equal(s2.store.getAgent(a2.id)!.status, 'waiting');
  assert.doesNotMatch(s2.store.getAgent(a2.id)!.waitingReason ?? '', /usage limit/);
  system.store.close();
  s2.store.close();
});

test('an exhausted overage allowance parks too, and says so', async () => {
  const { system, agent, child } = await fleet();
  child.rateLimit({
    status: 'allowed',
    overageStatus: 'rejected',
    isUsingOverage: true,
    rateLimitType: 'overage',
    resetsAt: 1_776_000_000,
  });
  child.result('error_during_execution', true);

  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id]);
  assert.match(system.store.getAgent(agent.id)!.waitingReason ?? '', /overage allowance is spent/);
  system.store.close();
});

test('an agent that finished the work is done, limit or no limit', async () => {
  const { system, agent, child } = await fleet();
  child.speak('All tests pass. @@LUBBDUBB_DONE@@');
  child.rateLimit(REJECTED);
  child.result();

  assert.equal(system.store.getAgent(agent.id)!.status, 'done', 'a settled ending is not resurrected as a park');
  assert.equal(system.agents.limitedAgentIds().length, 0);
  system.store.close();
});

test('resuming a limit-parked agent re-opens the same session in the same worktree', async () => {
  const { system, agent, child, children } = await fleet();
  child.speak('Halfway through the migration.');
  child.rateLimit(REJECTED);
  child.result('error_during_execution', true);
  child.exit(1);
  const transcript = system.store.getTranscript(agent.id);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/resume` });
  assert.equal(res.statusCode, 200);

  assert.equal(children.length, 2, 'the conversation is re-opened, not restarted');
  const relaunch = children[1]!;
  const spawnArgs = system.store.getAgent(agent.id)!;
  assert.equal(spawnArgs.status, 'running', 'the agent is back at work');
  assert.equal(spawnArgs.sessionId, agent.sessionId, 'the same conversation');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'running');
  assert.equal(system.agents.isLive(agent.id), true);
  assert.deepEqual(system.agents.limitedAgentIds(), [], 'the park is over');
  assert.ok(
    relaunch.writes.some((w) => w.includes('usage limit') && w.includes('Continue the task')),
    'the agent is told why it stopped and to carry on — not that the server restarted',
  );

  relaunch.speak('Migration finished.');
  const after = system.store.getTranscript(agent.id);
  assert.ok(after.startsWith(transcript), 'what was already there is untouched');
  assert.ok(after.includes('Migration finished'));

  await app.close();
  system.store.close();
});

test('a park whose process survived is resumed down the stdin it already has', async () => {
  const { system, agent, child, children } = await fleet();
  child.rateLimit(REJECTED);
  child.result('error_during_execution', true);
  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id]);
  assert.equal(system.agents.isLive(agent.id), true);

  const { app } = await buildApp(system);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/resume` })).statusCode, 200);

  assert.equal(children.length, 1, 'a live session is not relaunched underneath itself');
  assert.ok(child.writes.some((w) => w.includes('Continue the task')));
  assert.equal(system.store.getAgent(agent.id)!.status, 'running');
  assert.deepEqual(system.agents.limitedAgentIds(), []);
  await app.close();
  system.store.close();
});

test('resume refuses anything that is not a limit park, and says which', async () => {
  const { system, agent, child } = await fleet();
  const { app } = await buildApp(system);

  child.speak('Still working.');
  const busy = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/resume` });
  assert.equal(busy.statusCode, 409);
  assert.match(busy.json<{ error: string }>().error, /not parked on a usage limit/);

  const missing = await app.inject({ method: 'POST', url: '/api/agents/nope/resume' });
  assert.equal(missing.statusCode, 409);

  await app.close();
  system.store.close();
});

test('a park whose window has turned over is resumed by the pulse, with nobody asked', async () => {
  const { system, agent, child, children } = await fleet();
  child.speak('Halfway through the migration.');
  child.rateLimit(rejectedIn(-60_000));
  child.result('error_during_execution', true);
  child.exit(1);
  const before = children.length;

  await system.harness.runCycle('manual');

  assert.equal(children.length, before + 1, 'the conversation is re-opened, not restarted');
  const relaunch = children[before]!;
  const row = system.store.getAgent(agent.id)!;
  assert.equal(row.status, 'running', 'back at work without anyone being asked');
  assert.equal(row.sessionId, agent.sessionId, 'and in the same conversation');
  assert.equal(row.waitingReason, null, 'the park sentence is gone with the park');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'running');
  assert.deepEqual(system.agents.limitedAgentIds(), [], 'the park is over');
  assert.ok(
    relaunch.writes.some((w) => w.includes('usage limit') && w.includes('Continue the task')),
    'and it is told why it stopped, not that an operator did anything',
  );
  assert.equal(system.store.listErrors().length, 0, 'a resume that worked records no failure');
  assert.equal(system.store.listOpenEscalations().length, 0, 'nobody was asked a question');
  system.store.close();
});

test('a park whose window has not turned over yet is left where it is', async () => {
  const { system, agent, child, children } = await fleet();
  child.rateLimit(rejectedIn(60 * 60 * 1000));
  child.result('error_during_execution', true);
  child.exit(1);
  const before = children.length;

  await system.harness.runCycle('manual');

  assert.equal(children.length, before, 'nothing is relaunched into an account still spent');
  assert.equal(system.store.getAgent(agent.id)!.status, 'waiting', 'still parked');
  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id]);
  system.store.close();
});

test('a park claude gave no reset time for waits for a person, however many pulses pass', async () => {
  const { system, agent, child, children } = await fleet();
  child.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
  child.result('error_during_execution', true);
  child.exit(1);
  const before = children.length;

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  assert.equal(children.length, before, 'no clock, so no automatic resume — ever');
  assert.deepEqual(system.agents.limitedAgentIds(), [agent.id]);

  const { app } = await buildApp(system);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/resume` })).statusCode, 200);
  assert.equal(system.store.getAgent(agent.id)!.status, 'running');
  await app.close();
  system.store.close();
});

test('a limit park still lets an operator kill the agent, and killing ends the park', async () => {
  const { system, agent, child } = await fleet();
  child.rateLimit(REJECTED);
  child.result('error_during_execution', true);
  child.exit(1);

  assert.equal(system.agents.kill(agent.id), true);
  assert.equal(system.store.getAgent(agent.id)!.status, 'killed');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'interrupted');
  assert.deepEqual(system.agents.limitedAgentIds(), [], 'a decided ending is not a park');
  system.store.close();
});

test('the cockpit draws the park where the agent is, with a way out of it', async () => {
  const { buildDemoState } = await import('../web/src/demo/fixtures.js');
  const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
  const { RefLinks } = await import('../web/src/components/refs.js');
  const { goalIssue } = await import('../web/src/view/goalPage.js');
  const { hasPrPage } = await import('../web/src/view/prPage.js');

  const state = buildDemoState().state;
  const parked = state.agents.find((a) => a.endedAt === null)!;
  parked.status = 'waiting';
  parked.waitingReason = "Parked on a usage limit: this account's five-hour usage limit is spent.";
  state.parkedOnLimit = [parked.id];

  const rows = buildNeedsYou(state);
  const row = rows.find((r) => r.kind === 'limit');
  assert.ok(row, 'a parked fleet is something that needs you, not a silence');
  assert.equal(row.agentId, parked.id);
  assert.equal(row.group, 'blocking', 'an agent is stopped and only you can start it');
  assert.match(row.title, /usage limit/i);

  const view = buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: null,
    consolePanel: null,
    tab: 'overview',
  });
  assert.ok(view.limitParked.has(parked.id));

  const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;
  const html = renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(state, n),
      children: createElement(ConsoleRoot, { view, actions }),
    }),
  );
  assert.ok(html.includes('Resume'), 'the fleet row carries the control that ends the park');
  assert.ok(html.includes('Out of account limit'), 'and says why the row is stopped');
});
