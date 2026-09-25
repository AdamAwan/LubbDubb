import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildTools } from '../src/mcp/tools.js';
import { STEP_KINDS } from '../src/validation/steps.js';
import { ValidationCheckSchema } from '../src/validation/checkDocument.js';
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

test('both transports advertise “expects” as a suite step’s, beside the area it rides with', () => {
  const system = build();
  const agent = spawnAgent(system);
  for (const name of ['validation_plan', 'validation_amend']) {
    const step = checkFields(system, agent, name)['steps']?.items?.properties;
    assert.ok(step?.['expects'], `${name} advertises the expectation, or no author ever writes one down`);
    assert.match(
      step['expects']?.description ?? '',
      /"suite" step only/,
      `${name} says whose field it is — the strict schema refuses it anywhere else, and an agent that ` +
        'only learns that from a rejection has already lost the check set it wrote',
    );
    assert.match(
      step['expects']?.description ?? '',
      /deleted or renamed/,
      'and says why writing them down is the only thing that can catch a spec that has gone',
    );
  }
});

test('the strict schema permits expects on a suite step and refuses it on every other kind', () => {
  const base = { id: 'an-order-places', title: 'An order places', do: 'Place one.', expect: 'It places.' };
  const suite = ValidationCheckSchema.safeParse({
    ...base,
    steps: [{ kind: 'suite', do: 'Run the checkout area', area: 'checkout', expects: ['checkout/places.spec.ts'] }],
  });
  assert.ok(suite.success, 'a suite step names the area it runs and may name the specs it expects of it');
  assert.deepEqual(suite.data.steps?.[0]?.expects, ['checkout/places.spec.ts']);

  for (const kind of STEP_KINDS.filter((k) => k !== 'suite')) {
    const parsed = ValidationCheckSchema.safeParse({
      ...base,
      steps: [{ kind, do: 'Do the thing', expects: ['checkout/places.spec.ts'] }],
    });
    assert.equal(parsed.success, false, `a ${kind} step runs no named spec of the suite, so it may not expect one`);
    assert.match(
      parsed.error?.issues.map((i) => i.message).join(' ') ?? '',
      /"expects" belongs to a "suite" step/,
      'a second author for a string the pre-flight compares character for character is a silent undo, ' +
        `so a ${kind} step is refused rather than quietly dropped`,
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
