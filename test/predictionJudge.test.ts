import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { issueOriginRef } from '../src/issueOrigins.js';
import { toolsForRule, UNIVERSAL_TOOLS } from '../src/mcp/names.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { desktopDeps } from './support/desktop.js';
import { failAppraisalOpen, planWithOnePart } from './support/plans.js';

// → docs/spec/14-persistence.md#the-prediction-judge

const SENTINEL = 'ZZQX-JUDGE-LOCUS-SENTINEL';

class FakeChild extends EventEmitter implements StreamChild {
  pid = 556;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

const text = (result: unknown): string => JSON.stringify(result);

test('the judge is sealed: handed its one tool, launched with no built-in tool, and read by no model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-judge-'));
  const launches: string[][] = [];
  const spawner: Spawner = (_command, args) => {
    launches.push(args);
    return new FakeChild();
  };
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'stream',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      repoRoot: dir,
      heartbeatIntervalMs: 999_999,
      prediction: { enabled: true },
    }),
    {
      worktrees: new FakeWorktreeManager(),
      gitObserver: new FakeGitObserver(),
      streamSpawner: spawner,
      errorMirror: () => {},
    },
  );
  const { app } = await buildApp(system);
  const desktop = new McpDesktopServer({
    ...desktopDeps(system),
    now: () => new Date().toISOString(),
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\lubbdubb-judge-${Date.now()}` : join(dir, 'ops.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await desktop.listen());
  try {
    system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
    failAppraisalOpen(system.store, 1);
    await system.harness.runCycle('manual');
    const predicted = await app.inject({
      method: 'POST',
      url: '/api/goals/1/prediction',
      payload: { locus: SENTINEL, cause: 'the cache' },
    });
    assert.equal(predicted.statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/goals/1/reveal' })).statusCode, 200);
    planWithOnePart(system.store, 1, 'Ship the thing');

    await system.harness.runCycle('manual');
    const judgeOrigin = issueOriginRef('predictionJudge', 1);
    const judgeTask = () => system.store.tasks.listTasks().find((t) => t.originRef === judgeOrigin);
    assert.equal(judgeTask(), undefined, 'no judge before the operator has marked');

    const marked = await app.inject({
      method: 'POST',
      url: '/api/goals/1/prediction/marks',
      payload: { locus: 'matched', cause: 'missed' },
    });
    assert.equal(marked.statusCode, 200);
    await system.harness.runCycle('manual');

    const task = judgeTask();
    assert.ok(task, 'the judge is dispatched once the operator has marked');
    assert.equal(task.kind, 'desk');
    const full = system.store.tasks.getTask(task.id)!;
    assert.equal(full.prompt.includes(SENTINEL), false, 'the prompt carries no prediction text');
    const agent = system.store.agents.listAgents().find((a) => a.taskId === task.id)!;

    const launch = launches.find((args) => args.includes('--tools'));
    assert.ok(launch, 'the judge is launched with an allow-list of built-in tools');
    assert.equal(launch[launch.indexOf('--tools') + 1], '', 'and that list is empty');
    assert.equal(
      launches.filter((args) => args.includes('--tools')).length,
      1,
      'only the sealed launch carries it — every other agent keeps its tools',
    );
    assert.equal(text(launch).includes('Bash(npm'), false, "the operator's allow-list is not handed to it");
    assert.ok(launch.includes('--strict-mcp-config'), 'no MCP server from the operator’s own settings loads');
    assert.equal(
      launch.includes('--permission-prompt-tool'),
      false,
      'its channel serves no permission tool, so the launch names none',
    );
    assert.equal(text(launch).includes(SENTINEL), false);

    assert.deepEqual([...toolsForRule('prediction-judge')], ['prediction_judge']);
    const session = system.mcp.session(agent.id)!;
    for (const name of UNIVERSAL_TOOLS) {
      const refused = (await session.call(name, {})) as ToolCallResult & { isError?: boolean };
      assert.equal(text(refused).includes(SENTINEL), false);
      assert.ok(refused.isError === true || text(refused).includes('nknown'), `${name} is not callable when sealed`);
    }

    const read = await session.call('prediction_judge', { action: 'read' });
    assert.ok(text(read).includes(SENTINEL), 'the judge is handed the prediction by its tool');
    assert.ok(text(read).includes('whole'), 'and the plan beside it');

    const skipped = (await session.call('prediction_judge', { action: 'mark', split: 'matched' })) as ToolCallResult;
    assert.equal(skipped.isError, true, 'a skipped slot has nothing to mark');
    const answered = (await session.call('prediction_judge', {
      action: 'mark',
      locus: 'matched',
      cause: 'matched',
    })) as ToolCallResult;
    assert.equal(answered.isError, undefined, text(answered));

    const reading = (await app.inject({ method: 'GET', url: '/api/goals/1/prediction' })).json() as {
      prediction: { planMarks: Record<string, string | null>; judgeMarks: Record<string, string | null> };
    };
    assert.equal(reading.prediction.judgeMarks.cause, 'matched');
    assert.equal(reading.prediction.planMarks.cause, 'missed', "the operator's reading is untouched");

    const agentRead = await desktop.session('c1')!.call('agent_read', { agentId: agent.id });
    assert.equal(text(agentRead).includes(SENTINEL), false, 'agent_read withholds what the judge was handed');
    const ejected = system.ejections.eject(agent.id, 'take it');
    assert.equal(ejected.ok, false, 'a sealed agent cannot be ejected');

    const planner = system.store.agents
      .listAgents()
      .find((a) => system.store.tasks.getTask(a.taskId)?.originRef === issueOriginRef('plan', 1));
    assert.ok(planner);
    const refused = (await system.mcp
      .session(planner.id)!
      .call('prediction_judge', { action: 'read' })) as ToolCallResult;
    assert.equal(refused.isError, true, 'no other agent can ask for the brief');
    assert.equal(text(refused).includes(SENTINEL), false);

    system.store.tasks.updateTask(task.id, { status: 'done' });
    await system.harness.runCycle('manual');
    assert.equal(
      system.store.tasks.listTasks().filter((t) => t.originRef === judgeOrigin).length,
      1,
      'the judge is dispatched once per goal',
    );
  } finally {
    await desktop.close();
    await app.close();
    system.store.close();
  }
});

test('a judge is owed only for a mark made after the feature arrived, and never for a closed goal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-judge-owed-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      repoRoot: dir,
      heartbeatIntervalMs: 999_999,
      prediction: { enabled: true },
    }),
    { worktrees: new FakeWorktreeManager(), gitObserver: new FakeGitObserver(), errorMirror: () => {} },
  );
  try {
    system.predictions.recordPrediction({ originRef: 'issue:5', author: null, slots: { locus: 'here' } });
    system.predictions.recordReveal('issue:5');
    assert.deepEqual(system.predictions.listJudgeOwed(), [], 'an unmarked prediction owes nothing');
    system.predictions.recordPlanMarks({ originRef: 'issue:5', marks: { locus: 'matched' } });
    assert.deepEqual(system.predictions.listJudgeOwed(), ['issue:5'], 'the mark is what makes one owed');

    system.connector.inject({ kind: 'new_issue', number: 5, title: 'Closed already', body: '' });
    system.connector.inject({ kind: 'issue_state', number: 5, state: 'closed' });
    planWithOnePart(system.store, 5);
    await system.harness.runCycle('manual');
    assert.equal(
      system.store.tasks.listTasks().some((t) => t.originRef === issueOriginRef('predictionJudge', 5)),
      false,
      'a closed goal gets no judge',
    );
  } finally {
    system.store.close();
  }
});
