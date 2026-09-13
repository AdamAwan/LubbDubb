import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildTools } from '../src/mcp/tools.js';
import { STEP_KINDS } from '../src/validation/steps.js';
import type { Agent } from '../src/types.js';

// → docs/spec/11-mcp-tools.md, docs/spec/20-validation.md#the-test-plan

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  description?: string;
  enum?: string[];
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vsteps-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
}

function spawnAgent(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Work issue:12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: 'Ship it',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

function checkFields(system: System, agent: Agent, name: string): Record<string, JsonSchema> {
  const task = system.store.tasks.getTask(agent.taskId);
  assert.ok(task, 'the spawned agent has its task');
  const tool = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find((t) => t.name === name);
  assert.ok(tool, `${name} is advertised, so the name and the module agree`);
  const schema = tool.inputSchema as unknown as JsonSchema;
  const fields = schema.properties?.['checks']?.items?.properties;
  assert.ok(fields, `${name} advertises a check shape`);
  return fields;
}

test('both check-set transports advertise one test-plan shape', () => {
  const system = build();
  const agent = spawnAgent(system);
  const plan = checkFields(system, agent, 'validation_plan');
  const amend = checkFields(system, agent, 'validation_amend');

  assert.deepEqual(
    plan['steps'],
    amend['steps'],
    'a step kind means the same thing in both tools, so the advertised test plan is one shape — ' +
      'declared once as validationStepsSchema',
  );
  assert.deepEqual(
    Object.keys(plan),
    Object.keys(amend),
    'the two check shapes differ only in their prose, never in which fields they carry',
  );
});

test('the advertised step kinds are read off STEP_KINDS, not restated', () => {
  const system = build();
  const agent = spawnAgent(system);
  for (const name of ['validation_plan', 'validation_amend']) {
    const kind = checkFields(system, agent, name)['steps']?.items?.properties?.['kind'];
    assert.deepEqual(
      kind?.enum,
      [...STEP_KINDS],
      `${name} offers exactly the step vocabulary the harness resolves, in its order`,
    );
  }
});

test('the prose that differs between the two transports still differs', () => {
  const system = build();
  const agent = spawnAgent(system);
  const plan = checkFields(system, agent, 'validation_plan');
  const amend = checkFields(system, agent, 'validation_amend');

  // One tool authors a whole set against a delivered goal; the other amends the checks it names.
  // The descriptions are the prompt the agent reads, so folding them together changes behaviour.
  for (const field of ['do', 'expect', 'fleetCandidate']) {
    assert.notEqual(
      plan[field]?.description,
      amend[field]?.description,
      `"${field}" is written for each tool's own job and must not be homogenised`,
    );
  }
  for (const field of ['id', 'title', 'uses', 'covers', 'why']) {
    assert.equal(plan[field]?.description, amend[field]?.description, `"${field}" says the same thing in both tools`);
  }
});
