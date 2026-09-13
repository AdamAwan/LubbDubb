import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { parseActions } from '../src/dispatcher/actions.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { handoverResumeFor } from '../src/executor/handoverResume.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Issue } from '../src/types.js';

const NOW = '2026-08-19T12:00:00.000Z';

class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {}
}

interface Launch {
  args: string[];
  cwd: string;
}

function recordingSpawner(): { spawner: Spawner; launches: Launch[] } {
  const launches: Launch[] = [];
  const spawner: Spawner = (_command, args, opts) => {
    launches.push({ args, cwd: opts.cwd });
    return new FakeChild();
  };
  return { spawner, launches };
}

function testConfig(extra: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-handover-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    ...extra,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'the export should open in Excel with its columns intact',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function build(): { system: System; launches: Launch[]; worktrees: FakeWorktreeManager } {
  const { spawner, launches } = recordingSpawner();
  const worktrees = new FakeWorktreeManager();
  const system = buildSystem(testConfig(), { worktrees, streamSpawner: spawner, errorMirror: () => {} });
  system.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [], issues: [issue()] });
  return { system, launches, worktrees };
}

async function dispatch(system: System, origin: string, branch: string, rule: string): Promise<void> {
  const parsed = parseActions([
    {
      type: 'dispatch_code_agent',
      branch,
      base: 'main',
      readOnly: true,
      title: `${rule} issue #12`,
      prompt: `Issue #12 ("Ship it") — ${rule}.`,
      originRef: origin,
      rule,
      reason: 'The test asked.',
    },
  ]);
  assert.equal(parsed.rejected.length, 0, 'the test action is valid');
  await system.executor.execute(`cycle_${origin}_${system.store.tasks.listTasks().length}`, {
    ...parsed,
    rationale: '',
  });
}

function appraise(system: System, over: { verdict?: 'workable' | 'unclear'; goalRef?: string } = {}): void {
  const agent = system.store.agents.listAgents()[0]!;
  system.store.verdicts.recordAppraisal({
    originRef: 'issue:12',
    verdict: over.verdict ?? 'workable',
    summary: 'There is a goal here.',
    goalRef: over.goalRef ?? goalFingerprint(issue().title, issue().body),
    by: 'appraiser',
    agentId: agent.id,
    taskId: agent.taskId,
  });
}

function finishLiveAgent(system: System, worktrees?: FakeWorktreeManager): void {
  const live = system.store.agents.listAgentsByStatus('starting', 'running')[0];
  assert.ok(live, 'there is a live agent to finish');
  assert.equal(system.agents.complete(live.id), true);
  const branch = system.store.tasks.getTask(live.taskId)!.branch;
  if (worktrees && branch !== null) void worktrees.remove(branch);
}

function sessionFlag(launch: Launch): { flag: string; id: string } {
  const i = launch.args.findIndex((a) => a === '--session-id' || a === '--resume');
  assert.notEqual(i, -1, 'the launch pins or resumes a session');
  return { flag: launch.args[i]!, id: launch.args[i + 1]! };
}

async function appraiseThenPlan(
  system: System,
  worktrees: FakeWorktreeManager,
  over: Parameters<typeof appraise>[1] = {},
): Promise<void> {
  await dispatch(system, 'issue:12:appraisal', 'appraisal/issue/12', 'issue-appraisal');
  finishLiveAgent(system, worktrees);
  appraise(system, over);
  await dispatch(system, 'issue:12:plan', 'plan/issue/12', 'issue-plan');
}

test('the planner inherits the appraiser’s conversation rather than reading the ticket twice', async () => {
  const { system, launches, worktrees } = build();
  await appraiseThenPlan(system, worktrees);

  assert.equal(launches.length, 2, 'two launches');
  assert.equal(launches[1]!.cwd, launches[0]!.cwd, 'the warm slot of the same ref, which is where the transcript is');
  const appraiser = sessionFlag(launches[0]!);
  const planner = sessionFlag(launches[1]!);
  assert.equal(appraiser.flag, '--session-id');
  assert.equal(planner.flag, '--resume');
  assert.equal(planner.id, appraiser.id, 'the planner re-opens the appraiser’s conversation');
  assert.equal(launches[1]!.args.includes('--session-id'), false, 'and never both flags at once');

  const agents = system.store.agents.listAgents();
  assert.equal(agents.length, 2, 'a handover writes its own agent row');
  assert.notEqual(
    system.store.tasks.getTask(agents[0]!.taskId)!.originRef,
    system.store.tasks.getTask(agents[1]!.taskId)!.originRef,
    'the two rows are on their own origins — the handover is across them, not within one',
  );

  const planTask = system.store.tasks.getTask(agents[0]!.taskId)!;
  assert.match(planTask.prompt, /You appraised this goal/i);
  assert.match(planTask.prompt, /in the checkout you appraised from, and it has been swept/i);
  assert.doesNotMatch(planTask.prompt, /this is attempt 2/i, 'a handover is not a retry, and must not read as one');
  assert.equal(
    planTask.prompt.indexOf('You appraised this goal') < planTask.prompt.indexOf('Issue #12'),
    true,
    'the note comes before the restated goal',
  );

  assert.match(
    system.store.decisions.listDecisions().find((d) => d.detail.includes('Handed'))!.detail,
    /Handed issue:12:appraisal's conversation on/,
  );

  system.store.close();
});

test('a goal edited since the appraisal starts the planner cold — the transcript read other text', async () => {
  const { system, launches, worktrees } = build();
  await appraiseThenPlan(system, worktrees, { goalRef: goalFingerprint('Ship it', 'something else entirely') });

  assert.equal(sessionFlag(launches[1]!).flag, '--session-id', 'a fresh conversation');
  const planTask = system.store.tasks.getTask(system.store.agents.listAgents()[0]!.taskId)!;
  assert.doesNotMatch(planTask.prompt, /You appraised this goal/i);

  system.store.close();
});

test('an unclear verdict hands nothing on, and neither does a missing one', async () => {
  const { system, worktrees } = build();
  assert.equal(handoverResumeFor('issue:12:plan', system.store, [issue()]), null, 'no appraisal at all');

  await dispatch(system, 'issue:12:appraisal', 'appraisal/issue/12', 'issue-appraisal');
  finishLiveAgent(system, worktrees);
  appraise(system, { verdict: 'unclear' });
  assert.equal(handoverResumeFor('issue:12:plan', system.store, [issue()]), null, 'a refused goal');

  system.store.close();
});

test('a killed appraiser hands nothing on', async () => {
  const { system, launches } = build();
  await dispatch(system, 'issue:12:appraisal', 'appraisal/issue/12', 'issue-appraisal');
  const live = system.store.agents.listAgentsByStatus('starting', 'running')[0]!;
  appraise(system);
  system.agents.kill(live.id);

  assert.equal(handoverResumeFor('issue:12:plan', system.store, [issue()]), null, 'a decided ending is not inherited');
  await dispatch(system, 'issue:12:plan', 'plan/issue/12', 'issue-plan');
  assert.equal(sessionFlag(launches[1]!).flag, '--session-id');

  system.store.close();
});

test('a handover into a different slot is dropped — and the note goes with it', async () => {
  const { system, launches, worktrees } = build();
  await dispatch(system, 'issue:12:appraisal', 'appraisal/issue/12', 'issue-appraisal');
  finishLiveAgent(system, worktrees);
  appraise(system);
  await dispatch(system, 'issue:99:assess', 'assess/issue/99', 'issue-assess');

  await dispatch(system, 'issue:12:plan', 'plan/issue/12', 'issue-plan');
  assert.notEqual(launches[2]!.cwd, launches[0]!.cwd, 'an assessor took the warm slot first');
  assert.equal(
    sessionFlag(launches[2]!).flag,
    '--session-id',
    'a transcript is keyed to its launch directory, so resuming elsewhere finds nothing at all',
  );
  const planTask = system.store.tasks.getTask(system.store.agents.listAgents()[0]!.taskId)!;
  assert.doesNotMatch(planTask.prompt, /You appraised this goal/i, 'and a cold agent is never told it has a memory');

  system.store.close();
});

test('a replan inherits the planner it is redoing, never the appraiser behind it', async () => {
  const { system, launches, worktrees } = build();
  await appraiseThenPlan(system, worktrees);
  finishLiveAgent(system, worktrees);
  await dispatch(system, 'issue:12:plan', 'plan/issue/12', 'issue-plan');

  assert.equal(launches.length, 3);
  assert.equal(sessionFlag(launches[2]!).flag, '--resume');
  const replanTask = system.store.tasks.getTask(system.store.agents.listAgents()[0]!.taskId)!;
  assert.match(replanTask.prompt, /this is attempt 2/i, 'the retry on its own origin wins');
  assert.doesNotMatch(replanTask.prompt, /You appraised this goal/i, 'and the stale appraisal note is not re-added');

  system.store.close();
});

test('only the planner inherits — no other origin is handed a conversation', async () => {
  const { system, worktrees } = build();
  await dispatch(system, 'issue:12:appraisal', 'appraisal/issue/12', 'issue-appraisal');
  finishLiveAgent(system, worktrees);
  appraise(system);

  for (const origin of ['issue:12', 'issue:12:assess', 'issue:12:retro', 'issue:12:part:schema'])
    assert.equal(handoverResumeFor(origin, system.store, [issue()]), null, `${origin} declares no handover`);

  system.store.close();
});
