import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { parseActions } from '../src/dispatcher/actions.js';
import { retryResumeFor } from '../src/executor/retryResume.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

/**
 * A re-dispatched origin continues the previous agent's conversation (issue #333).
 *
 * The cooldown allows three attempts per origin and every one of them used to be a
 * cold session: attempt two re-read the repository and `CLAUDE.md` to re-derive
 * what attempt one had already worked out, then walked the same path because
 * nothing told it the path had been walked.
 *
 * Driven through `executor.execute` rather than `harness.runCycle` because every
 * dispatch rule routes through the cooldown, whose 15-minute gap is not
 * configurable — two cycles a few milliseconds apart never produce the second
 * dispatch this file is about. The executor is where the decision lives anyway.
 */

/** Fake headless `claude`: enough of the transport to launch, be completed, and be inspected. */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  /** Silent, like the real one: a signalled `claude` exits later, not inside `kill()`. */
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

function testConfig(mode: 'stream' | 'raw', extra: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-retry-resume-'));
  return loadConfig({
    ...extra,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: mode,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

/** One dispatch of `origin`, straight through the executor the harness would use. */
async function dispatch(
  system: System,
  origin: string,
  opts: { kind?: 'code' | 'desk'; branch?: string; prompt?: string } = {},
): Promise<void> {
  const kind = opts.kind ?? 'code';
  const raw =
    kind === 'code'
      ? {
          type: 'dispatch_code_agent',
          branch: opts.branch ?? 'issue/901',
          title: 'Resolve issue #901',
          prompt: opts.prompt ?? 'Resolve issue #901.',
          originRef: origin,
          rule: 'issue-pickup',
          reason: 'Open issue #901 has no open PR.',
        }
      : {
          type: 'dispatch_desk_agent',
          title: 'Look into #901',
          prompt: opts.prompt ?? 'Look into it.',
          originRef: origin,
          rule: 'manual-job',
          reason: 'The operator asked.',
        };
  const parsed = parseActions([raw]);
  assert.equal(parsed.rejected.length, 0, 'the test action is valid');
  await system.executor.execute(`cycle_${origin}_${system.store.listTasks().length}`, {
    ...parsed,
    rationale: '',
  });
}

/** Finish the one live agent the way an operator's `complete` does: `done`, nothing cleared. */
function finishLiveAgent(system: System): void {
  const live = system.store.listAgentsByStatus('starting', 'running')[0];
  assert.ok(live, 'there is a live agent to finish');
  assert.equal(system.agents.complete(live.id), true);
  assert.equal(system.store.getAgent(live.id)!.status, 'done');
}

/** The `--session-id <id>` / `--resume <id>` pair, as the launch actually carried it. */
function sessionFlag(launch: Launch): { flag: string; id: string } {
  const i = launch.args.findIndex((a) => a === '--session-id' || a === '--resume');
  assert.notEqual(i, -1, 'the launch pins or resumes a session');
  return { flag: launch.args[i]!, id: launch.args[i + 1]! };
}

test('a re-dispatched origin resumes the previous agent’s conversation instead of starting cold', async () => {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(testConfig('stream'), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:901');
  finishLiveAgent(system);
  await dispatch(system, 'issue:901');

  assert.equal(launches.length, 2, 'two launches');
  const first = sessionFlag(launches[0]!);
  const second = sessionFlag(launches[1]!);

  // Attempt one mints an id and pins it; attempt two re-opens that same
  // conversation. Never both flags on one launch — `claude` exits 1 with no stream
  // event at all when a pinned id already has a transcript.
  assert.equal(first.flag, '--session-id');
  assert.equal(second.flag, '--resume');
  assert.equal(second.id, first.id, 'the second launch re-opens the first’s conversation');
  assert.equal(launches[1]!.args.includes('--session-id'), false, 'and does not also pin it');
  assert.equal(launches[1]!.cwd, launches[0]!.cwd, 'in the directory the transcript is keyed to');

  // Identity: a new task row and a new agent row, so `agent.taskId` still resolves
  // and each attempt's spend stays attributable to its own run on the same origin.
  const agents = system.store.listAgents();
  assert.equal(agents.length, 2, 'a retry writes a new agent row rather than reusing one');
  assert.notEqual(agents[0]!.taskId, agents[1]!.taskId, 'each attempt owns its task row');
  assert.equal(agents[0]!.sessionId, agents[1]!.sessionId, 'both rows name the one conversation');
  for (const agent of agents) {
    assert.equal(system.store.getTask(agent.taskId)!.originRef, 'issue:901', 'both attempts on the same origin');
  }

  // The agent is told it is a retry, in the prompt its own row stores — the two
  // must not diverge, or the cockpit shows something the agent never saw.
  const retryTask = system.store.getTask(agents[0]!.taskId)!;
  assert.match(retryTask.prompt, /this is attempt 2/i);
  assert.match(retryTask.prompt, /without the concern being cleared/i);
  assert.match(retryTask.prompt, /worktree was removed/i, 'a code retry is warned its worktree was recreated');
  assert.match(retryTask.prompt, /Resolve issue #901\./, 'and still restates the concern as it stands now');
  assert.equal(
    retryTask.prompt.indexOf('attempt 2') < retryTask.prompt.indexOf('Resolve issue #901.'),
    true,
    'the retry note comes before the restated concern, not after it',
  );
  assert.doesNotMatch(retryTask.prompt, /resumed after a server restart/i, 'not the restart wording');

  // And the audit says what happened, not what was asked for. `listDecisions` is
  // newest-first, so the retry is the head of the list.
  const executed = system.store.listDecisions().filter((d) => d.outcome === 'executed');
  assert.match(executed[0]!.detail, /Resumed the previous agent's conversation/);

  system.store.close();
});

test('a first dispatch of an origin starts cold, and says so', async () => {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(testConfig('stream'), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:902', { branch: 'issue/902' });

  assert.equal(sessionFlag(launches[0]!).flag, '--session-id');
  const task = system.store.listTasks()[0]!;
  assert.doesNotMatch(task.prompt, /this is attempt/i, 'nothing to inherit, so no retry note');
  assert.match(system.store.listDecisions().find((d) => d.outcome === 'executed')!.detail, /^Spawned code agent/);

  system.store.close();
});

test('a conversation is inherited at most once — the attempt after a resume is cold again', async () => {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(testConfig('stream'), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:901');
  finishLiveAgent(system);
  await dispatch(system, 'issue:901');
  finishLiveAgent(system);
  await dispatch(system, 'issue:901');

  assert.equal(launches.length, 3);
  assert.equal(sessionFlag(launches[1]!).flag, '--resume');
  // Two rows already carry the id, so the third attempt does not pile onto a
  // conversation that has now failed twice — it mints a clean one.
  const third = sessionFlag(launches[2]!);
  assert.equal(third.flag, '--session-id');
  assert.notEqual(third.id, sessionFlag(launches[0]!).id, 'a fresh conversation, not the twice-failed one');

  system.store.close();
});

test('a live agent on the origin is never resumed — the dispatch is skipped as in-flight', async () => {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(testConfig('stream'), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:901');
  // Deliberately not finished: the agent is still live.
  await dispatch(system, 'issue:901');

  assert.equal(launches.length, 1, 'no second process on one conversation');
  const skipped = system.store.listDecisions().find((d) => d.outcome === 'skipped');
  assert.ok(skipped, 'the origin gate refused it');
  assert.match(skipped.detail, /already in flight/);

  // Belt and braces at the rule itself: the eligibility check would refuse a live
  // agent even if it were ever reached, because notifying one is `respond_to_agent`.
  assert.equal(retryResumeFor('issue:901', system.store), null);

  system.store.close();
});

test('a non-resumable runtime re-dispatches cold, and the audit does not claim otherwise', async () => {
  // `raw` runs the operator's argv verbatim and pins no session id, so there is no
  // conversation to inherit. The executor still offers one; the manager declines.
  const system = buildSystem(testConfig('raw'), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:901');
  finishLiveAgent(system);
  await dispatch(system, 'issue:901');

  const agents = system.store.listAgents();
  assert.equal(agents.length, 2);
  for (const agent of agents) assert.equal(agent.sessionId, null, 'raw pins nothing to resume');
  assert.match(
    system.store.listDecisions().filter((d) => d.outcome === 'executed')[0]!.detail,
    /^Spawned code agent/,
    'the audit reports the cold spawn that actually happened',
  );

  system.store.close();
});

test('a desk retry re-attaches in the previous scratch directory, not a fresh one', async () => {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(testConfig('stream'), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:903', { kind: 'desk' });
  finishLiveAgent(system);
  await dispatch(system, 'issue:903', { kind: 'desk' });

  // A desk cwd is `deskRoot/<task id>`, so a new task row would mean a new
  // directory — and `claude --resume` resolves the transcript inside the launch
  // directory's project dir, so it would find nothing there.
  assert.equal(launches[1]!.cwd, launches[0]!.cwd, 'the retry lands where its transcript is');
  assert.equal(sessionFlag(launches[1]!).flag, '--resume');
  const retryTask = system.store.getTask(system.store.listAgents()[0]!.taskId)!;
  assert.doesNotMatch(retryTask.prompt, /worktree was removed/i, 'a desk agent keeps its scratch dir');

  system.store.close();
});

test('a killed agent’s conversation is not inherited', async () => {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(testConfig('stream'), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });

  await dispatch(system, 'issue:901');
  const live = system.store.listAgentsByStatus('starting', 'running')[0]!;
  system.agents.kill(live.id);
  assert.equal(retryResumeFor('issue:901', system.store), null, 'a decided ending is not resumed');

  await dispatch(system, 'issue:901');
  assert.equal(sessionFlag(launches[1]!).flag, '--session-id', 'so the next attempt is cold');

  system.store.close();
});
