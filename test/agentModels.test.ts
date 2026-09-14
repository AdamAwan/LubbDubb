import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { resolveAgentProfile } from '../src/agents/modelPolicy.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

const PROFILES = {
  fast: { model: 'haiku', permissionMode: 'acceptEdits', rank: 1, description: 'mechanical work' },
  standard: { model: 'sonnet', effort: 'medium', rank: 2, description: 'ordinary work' },
  deep: { model: 'opus', effort: 'medium', rank: 3, description: 'work whose shape is unclear' },
} as const;

test('a rule with an assignment resolves to that profile', () => {
  const models = { profiles: PROFILES, default: 'standard', byRule: { 'issue-plan': 'deep' } };
  assert.deepEqual(resolveAgentProfile(models, 'issue-plan'), {
    name: 'deep',
    model: 'opus',
    effort: 'medium',
    permissionMode: null,
    source: 'rule',
  });
});

test('a rule with no assignment falls through to the default, as does a dispatch with no rule', () => {
  const models = { profiles: PROFILES, default: 'standard', byRule: { 'issue-plan': 'deep' } };
  const standard = {
    name: 'standard',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: null,
    source: 'default',
  } as const;
  assert.deepEqual(resolveAgentProfile(models, 'pr-ci-failing'), standard);
  assert.deepEqual(resolveAgentProfile(models, null), standard);
});

test('no policy at all, or a policy with no default, resolves to no model', () => {
  assert.equal(resolveAgentProfile(undefined, 'issue-plan'), null);
  assert.equal(resolveAgentProfile({ profiles: PROFILES, byRule: { 'issue-plan': 'deep' } }, 'pr-ci-failing'), null);
});

test('a rule mapped explicitly to the default profile resolves the same as falling through', () => {
  const models = { profiles: PROFILES, default: 'standard', byRule: { 'issue-plan': 'standard' } };
  assert.deepEqual(resolveAgentProfile(models, 'issue-plan'), {
    name: 'standard',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: null,
    source: 'rule',
  });
  assert.deepEqual(resolveAgentProfile(models, 'issue-appraisal'), {
    name: 'standard',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: null,
    source: 'default',
  });
});

function load(agentModels: Config['agentModels']) {
  return loadConfig({ selfUpdate: { enabled: false } as never, dbPath: ':memory:', agentModels });
}

test('config load rejects a default naming a profile that does not exist', () => {
  assert.throws(() => load({ profiles: PROFILES, default: 'quick' }), /agentModels\.default names profile "quick"/);
});

test('config load rejects a byRule entry naming a profile that does not exist', () => {
  assert.throws(
    () => load({ profiles: PROFILES, byRule: { 'issue-plan': 'thorough' } }),
    /agentModels\.byRule\."issue-plan" names profile "thorough"/,
  );
});

test('config load rejects a byRule key that is not a dispatch rule id', () => {
  assert.throws(() => load({ profiles: PROFILES, byRule: { 'issue-planning': 'deep' } }), /"issue-planning"/);
  assert.throws(() => load({ profiles: PROFILES, byRule: { 'cooldown-escalate': 'deep' } }), /"cooldown-escalate"/);
});

test('config load rejects a profile written as a bare model string', () => {
  assert.throws(
    () => load({ profiles: { deep: 'opus' } as never }),
    /agentModels\.profiles\."deep" must be an object.*\{"model": "opus"\}/s,
  );
});

test('config load rejects an effort that is not a level', () => {
  assert.throws(
    () => load({ profiles: { deep: { model: 'opus', effort: 'maximum' } } as never }),
    /agentModels\.profiles\."deep"\.effort is "maximum".*low, medium, high, xhigh, max/s,
  );
});

test('config load rejects a permissionMode that is present but not a mode string', () => {
  assert.throws(
    () => load({ profiles: { deep: { model: 'opus', permissionMode: '' } } as never }),
    /agentModels\.profiles\."deep"\.permissionMode must be a non-empty mode string/,
  );
});

test('an omitted block loads, and a well-formed one survives the loader', () => {
  assert.equal(load(undefined).agentModels, undefined);
  const models = { profiles: PROFILES, default: 'standard', byRule: { 'issue-plan': 'deep' } };
  assert.deepEqual(load(models).agentModels, models);
});

test('the launch builder omits --model and --effort entirely when neither is set', () => {
  {
    const build = buildClaudeStreamArgs;
    const args = build({ permissionMode: 'acceptEdits' });
    assert.equal(args.includes('--model'), false);
    assert.equal(args.includes('--effort'), false);
  }
});

test('a profile with a model and no effort carries the one flag, not an empty second', () => {
  {
    const build = buildClaudeStreamArgs;
    const args = build({ model: 'haiku' });
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    assert.equal(args.includes('--effort'), false);
  }
});

test('the launch builder puts --model before the operator args, which keep the last word', () => {
  {
    const build = buildClaudeStreamArgs;
    const args = build({ model: 'opus', extraArgs: ['--model', 'sonnet'] });
    assert.equal(args.indexOf('--model') < args.lastIndexOf('--model'), true, 'ours is pushed first');
    assert.equal(args[args.lastIndexOf('--model') + 1], 'sonnet', "the operator's claudeArgs still win");
    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  }
});

test('the launch builder puts --effort before the operator args too', () => {
  {
    const build = buildClaudeStreamArgs;
    const args = build({ model: 'opus', effort: 'medium', extraArgs: ['--effort', 'max'] });
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    assert.equal(args[args.lastIndexOf('--effort') + 1], 'max', "the operator's claudeArgs still win");
  }
});

class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
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

function streamConfig(agentModels: Config['agentModels']) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-models-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    claudeArgs: ['--operator-arg'],
    agentModels,
  });
}

async function dispatch(agentModels: Config['agentModels'], n: number) {
  const launches: string[][] = [];
  const spawner: Spawner = (_command, args) => {
    launches.push(args);
    return new FakeChild();
  };
  const system = buildSystem(streamConfig(agentModels), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
  });
  system.connector.inject({ kind: 'new_issue', number: n, title: 'Add login' });
  failPlanningOpen(system.store, n);
  await system.harness.runCycle('manual');
  const task = system.store.tasks.getTask(system.store.agents.listAgentsByStatus('starting', 'running')[0]!.taskId)!;
  system.store.close();
  return { args: launches[0]!, task };
}

test('an assigned rule launches on its profile, and the task row records what it ran on', async () => {
  const { args, task } = await dispatch(
    { profiles: PROFILES, default: 'fast', byRule: { 'issue-pickup': 'deep' } },
    931,
  );
  assert.equal(task.rule, 'issue-pickup');
  assert.equal(task.model, 'opus', 'the resolved string is persisted, not the profile name');
  assert.equal(task.effort, 'medium', 'and the depth beside it, off the same profile');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.equal(args.indexOf('--model') < args.indexOf('--operator-arg'), true, 'before the operator args');
  assert.equal(args.indexOf('--effort') < args.indexOf('--operator-arg'), true, 'before the operator args');
});

test('a rule with no assignment launches on the policy default', async () => {
  const { args, task } = await dispatch({ profiles: PROFILES, default: 'fast', byRule: { 'issue-plan': 'deep' } }, 932);
  assert.equal(task.model, 'haiku');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(task.effort, null);
  assert.equal(args.includes('--effort'), false);
});

test('with no policy configured, no launch carries --model and no task records one', async () => {
  const { args, task } = await dispatch(undefined, 933);
  assert.equal(task.model, null);
  assert.equal(task.effort, null);
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--effort'), false);
});

test('a profile that names a permission mode launches under it, in place of the fleet-wide one', async () => {
  const { args, task } = await dispatch({ profiles: PROFILES, default: 'fast' }, 934);
  assert.equal(task.permissionMode, 'acceptEdits', 'resolved at dispatch and stored on the row');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test("a profile that names no permission mode launches on the fleet's own, which defaults to auto", async () => {
  const { args, task } = await dispatch({ profiles: PROFILES, default: 'deep' }, 935);
  assert.equal(task.permissionMode, 'auto', "the fleet's own is stamped on the row, so the drawer can read it");
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
});

test('with no policy at all, every launch carries the fleet-wide permission mode', async () => {
  const { args, task } = await dispatch(undefined, 936);
  assert.equal(task.permissionMode, 'auto', 'and records it, with no profile to have named one');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
});
