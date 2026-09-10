import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { outstandingChecks } from '../src/validation/verdict.js';
import { ValidationAskDesk } from '../src/validation/askDesk.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import type { Agent, ValidationCheck } from '../src/types.js';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vamend-'));
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
      ...overrides,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Ship it',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'csv-opens',
    title: 'The export opens in Excel',
    do: 'Export a report and open the file.',
    expect: 'It opens with the columns intact.',
    ...over,
  };
}

function planWith(
  system: System,
  checks: Record<string, unknown>[],
  resources: Record<string, unknown>[] = [],
): string {
  const parsed = validatePlanDocument({
    version: 1,
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'One small fix.',
    validation: { checks, resources },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: 'issue:12', title: 'Ship it' });
  return 'issue:12';
}

function checksOf(system: System, goal: string): ValidationCheck[] {
  return system.store.listValidationChecks(goal);
}

function byId(system: System, goal: string, id: string): ValidationCheck {
  const found = checksOf(system, goal).find((c) => c.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
}

test('the agent doing the work may amend; the planner is refused and told where to go', async () => {
  const system = build();
  planWith(system, [check()]);

  for (const origin of ['issue:12', 'issue:12:part:reader', 'issue:12:assess']) {
    const res = await callTool(system, spawnAgent(system, origin), 'validation_amend', {
      note: 'the command was renamed',
      checks: [check({ id: `from-${origin.replace(/[^a-z]+/g, '-')}`, title: 'A new check' })],
    });
    assert.equal(res.isError, false, `${origin} may amend its own goal's validation plan`);
  }

  // The refusal moved with the authoring: the check set is written after delivery, by the validation
  // planner, which has a transport speaking for the whole set. An ordinary planner has no
  // check-writing transport to be held to, so it is not a caller this tool refuses.
  const planner = await callTool(system, spawnAgent(system, 'issue:12:validate-plan'), 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'planner-check' })],
  });
  assert.equal(planner.isError, true);
  assert.match(planner.text, /validation_plan/);

  const stray = await callTool(system, spawnAgent(system, 'finding:9'), 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'stray' })],
  });
  assert.equal(stray.isError, true);
  assert.match(stray.text, /names no issue/);
});

test('an agent working another goal cannot reach this one — the origin is the credential, not an argument', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  const res = await callTool(system, spawnAgent(system, 'issue:99'), 'validation_amend', {
    note: 'nothing to do with #12',
    checks: [check({ id: 'elsewhere' })],
  });
  assert.equal(res.isError, true);
  assert.equal(checksOf(system, plan).length, 1);
});

test('an amendment naming one check leaves every other check exactly as it was', async () => {
  const system = build();
  const plan = planWith(system, [
    check({ id: 'a' }),
    check({ id: 'b', title: 'Second' }),
    check({ id: 'c', title: 'Third' }),
  ]);
  system.store.recordValidationResult(plan, 'b', { state: 'passed', note: 'ran it', by: 'operator' });

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'the export lives under Reports now',
    checks: [check({ id: 'a', do: 'Open Reports and export.' })],
  });
  assert.equal(res.isError, false);

  const live = checksOf(system, plan).filter((c) => c.supersededReason === null);
  assert.deepEqual(
    live.map((c) => c.id),
    ['a', 'b', 'c'],
  );
  assert.equal(byId(system, plan, 'b').state, 'passed');
  assert.equal(byId(system, plan, 'c').amendedAt, null);
});

test('an added check lands unrun, after the last, on the next free letter', async () => {
  const system = build();
  const plan = planWith(system, [check({ id: 'a' }), check({ id: 'b', title: 'Second' })]);

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'nothing checked the empty case',
    checks: [check({ id: 'empty-report', title: 'An empty report still exports' })],
  });
  assert.deepEqual(res.json().added, ['C. empty-report']);

  const added = byId(system, plan, 'empty-report');
  assert.equal(added.letter, 'C');
  assert.equal(added.state, 'unrun');
  assert.equal(added.seq, 3);
  assert.ok(added.amendedAt);
  assert.equal(added.revision, null);
  assert.match(added.amendNote ?? '', /nothing checked the empty case/);
});

test('rewording withdraws the result, keeps what it used to say, and says so to the agent', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  system.store.recordValidationResult(plan, 'csv-opens', {
    state: 'passed',
    note: 'Opened in Excel 2019, columns intact.',
    by: 'operator',
  });

  const res = await callTool(system, spawnAgent(system, 'issue:12:part:writer'), 'validation_amend', {
    note: 'it exports XLSX now, not CSV',
    checks: [check({ expect: 'It opens as a workbook with the columns intact.' })],
  });
  const body = res.json();
  assert.deepEqual(body.reworded, ['A. csv-opens']);
  assert.match(JSON.stringify(body.withdrewResults), /was passed, now unrun/);

  const after = byId(system, plan, 'csv-opens');
  assert.equal(after.state, 'unrun');
  assert.equal(after.resultNote, null);
  assert.equal(after.letter, 'A', 'the handle survives — 12:A is the same check');
  assert.equal(after.revision?.state, 'passed');
  assert.match(after.revision?.expect ?? '', /columns intact/);
  assert.match(after.revision?.note ?? '', /Excel 2019/);
});

test('a re-declaration word for word keeps the result and raises no band', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it', by: 'operator' });

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'tidying the references',
    checks: [check({ covers: ['reader'], fleetCandidate: true, why: 'it is a command-line check' })],
  });
  assert.deepEqual(res.json().unchanged, ['csv-opens']);

  const after = byId(system, plan, 'csv-opens');
  assert.equal(after.state, 'passed');
  assert.equal(after.resultNote, 'ran it');
  assert.equal(after.amendedAt, null);
  assert.equal(after.fleetCandidate, true, 'the suggestion still lands');
});

test('rewording a check nobody ran costs nothing, and the band does not claim otherwise', async () => {
  const system = build();
  const plan = planWith(system, [check()]);

  await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'clearer wording',
    checks: [check({ expect: 'It opens, columns intact.' })],
  });
  const after = byId(system, plan, 'csv-opens');
  assert.ok(after.amendedAt, 'the operator is still told the wording moved');
  assert.equal(after.revision?.state, null);
});

test('a withdrawal supersedes with its reason, keeps the letter, and never deletes', async () => {
  const system = build();
  const plan = planWith(system, [check({ id: 'a' }), check({ id: 'b', title: 'Second' })]);

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'the second export was dropped from scope',
    withdraw: [{ id: 'b', reason: 'the feature it checked is no longer being built' }],
  });
  assert.deepEqual(res.json().withdrawn, ['b']);

  const gone = byId(system, plan, 'b');
  assert.equal(gone.letter, 'B');
  assert.match(gone.supersededReason ?? '', /An agent working this goal withdrew this check/);
  assert.match(gone.supersededReason ?? '', /no longer being built/);

  await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'one more',
    checks: [check({ id: 'c', title: 'Third' })],
  });
  assert.equal(byId(system, plan, 'c').letter, 'C');
});

test('withdrawing an id this goal never had is reported, not silently accepted', async () => {
  const system = build();
  planWith(system, [check({ id: 'a' })]);
  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'tidy',
    withdraw: [{ id: 'typo', reason: 'not needed' }],
  });
  assert.equal(res.isError, false, 'the rest of a correction still lands');
  assert.deepEqual(res.json().notFound, ['typo']);
});

test('a withdrawn check declared again comes back live, on its own letter', async () => {
  const system = build();
  const plan = planWith(system, [check({ id: 'a' }), check({ id: 'b', title: 'Second' })]);
  const agent = spawnAgent(system, 'issue:12');
  await callTool(system, agent, 'validation_amend', {
    note: 'dropped',
    withdraw: [{ id: 'b', reason: 'out of scope' }],
  });

  const res = await callTool(system, agent, 'validation_amend', {
    note: 'it is back in scope after all',
    checks: [check({ id: 'b', title: 'Second' })],
  });
  assert.deepEqual(res.json().added, ['B. b']);
  const back = byId(system, plan, 'b');
  assert.equal(back.supersededReason, null);
  assert.equal(back.letter, 'B');
  assert.ok(back.amendedAt, 'and it is banded, because it reappeared');
});

test('an amendment is parsed by the plan document schema, so it refuses what that refuses', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  const agent = spawnAgent(system, 'issue:12');

  const actor = await callTool(system, agent, 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'x', actor: 'fleet' })],
  });
  assert.equal(actor.isError, true);
  assert.match(actor.text, /who runs it is not yours to say/);

  const path = await callTool(system, agent, 'validation_amend', {
    note: 'n',
    resources: [{ name: '../secrets.env' }],
    checks: [check({ id: 'x' })],
  });
  assert.equal(path.isError, true);
  assert.match(path.text, /file name, not a path/);

  assert.deepEqual(
    checksOf(system, plan).map((c) => c.id),
    ['csv-opens'],
  );
});

test('an amendment needs a note, needs to do something, and cannot both declare and withdraw one id', async () => {
  const system = build();
  planWith(system, [check({ id: 'a' })]);
  const agent = spawnAgent(system, 'issue:12');

  const noNote = await callTool(system, agent, 'validation_amend', { checks: [check({ id: 'b' })] });
  assert.equal(noNote.isError, true);
  assert.match(noNote.text, /note is required/);

  const empty = await callTool(system, agent, 'validation_amend', { note: 'thinking about it' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /at least one check/);

  const both = await callTool(system, agent, 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'a' })],
    withdraw: [{ id: 'a', reason: 'r' }],
  });
  assert.equal(both.isError, true);
  assert.match(both.text, /both declared and withdrawn/);
});

test('an amendment adds resources and removes none, and an unprovided one is asked for once delivered', async () => {
  const system = build();
  const plan = planWith(
    system,
    [check({ uses: ['seed.sql'] })],
    [{ name: 'seed.sql', kind: 'fixture', note: 'the seeded database' }],
  );

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'the new check needs a scrubbed dump of real orders',
    resources: [{ name: 'orders-dump.sql', kind: 'data', provided: false }],
    checks: [
      check({ id: 'orders-import', title: 'A week of real orders imports', uses: ['seed.sql', 'orders-dump.sql'] }),
    ],
  });
  assert.equal(res.isError, false);

  const names = system.store.listValidationResources(plan).map((r) => r.name);
  assert.deepEqual(names.sort(), ['orders-dump.sql', 'seed.sql']);
  assert.deepEqual(byId(system, plan, 'orders-import').uses.sort(), ['orders-dump.sql', 'seed.sql']);

  const asks = () => system.store.listHumanTasks().filter((t) => t.title.includes('orders-dump.sql'));
  const desk = new ValidationAskDesk(system.store);
  desk.run();
  assert.equal(asks().length, 0, 'nothing is delivered yet');

  system.store.recordDelivery({ originRef: plan, summary: 'delivered', by: 'assessor' });
  desk.run();
  assert.equal(asks().length, 1);
  assert.match(asks()[0]!.detail ?? '', /could not produce it/);
});

test('an amendment saying it can produce the resource after all withdraws the ask', async () => {
  const system = build();
  const plan = planWith(system, [check()], [{ name: 'orders-dump.sql', kind: 'data', provided: false }]);
  system.store.recordDelivery({ originRef: plan, summary: 'delivered', by: 'assessor' });
  new ValidationAskDesk(system.store).run();
  const [filed] = system.store.listHumanTasks();
  assert.equal(filed?.status, 'open');

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'I scrubbed and committed the dump myself while building this',
    resources: [{ name: 'orders-dump.sql', kind: 'data', provided: true }],
    checks: [check()],
  });
  assert.equal(res.isError, false);
  const settled = system.store.getHumanTask(filed!.id);
  assert.equal(settled?.status, 'declined');
  assert.match(settled?.resolution ?? '', /no longer needs this/);
});

test('with no plan the tool refuses rather than pretending', async () => {
  const system = build();
  const noPlan = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'x' })],
  });
  assert.equal(noPlan.isError, true);
  assert.match(noPlan.text, /has no plan/);
});

test('the band clears when the operator records a reading against the new wording', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it', by: 'operator' });
  await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'it is XLSX now',
    checks: [check({ expect: 'It opens as a workbook.' })],
  });
  assert.ok(byId(system, plan, 'csv-opens').amendedAt);

  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it again', by: 'operator' });
  const after = byId(system, plan, 'csv-opens');
  assert.equal(after.amendedAt, null);
  assert.equal(after.revision, null);
  assert.equal(after.amendNote, null);
});

test('a replan bands what it changed, and a plan first declaring its checks bands nothing', () => {
  const system = build();
  const plan = planWith(system, [check({ id: 'a' }), check({ id: 'b', title: 'Second' })]);
  assert.deepEqual(
    checksOf(system, plan).map((c) => c.amendedAt),
    [null, null],
  );

  system.store.recordValidationResult(plan, 'a', { state: 'passed', note: 'ran it', by: 'operator' });
  planWith(system, [check({ id: 'a', expect: 'It opens as a workbook.' }), check({ id: 'b', title: 'Second' })]);

  const a = byId(system, plan, 'a');
  assert.match(a.amendNote ?? '', /A replan changed this check/);
  assert.equal(a.revision?.state, 'passed');
  assert.equal(byId(system, plan, 'b').amendedAt, null, 'the check the replan left alone says nothing');
});

test('a withdrawn reading is stated off the cockpit too — on the close-out and on the ticket', () => {
  const system = build();
  const plan = planWith(system, [check()]);
  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it', by: 'operator' });
  planWith(system, [check({ expect: 'It opens as a workbook.' })]);
  const checks = checksOf(system, plan);

  const [line] = outstandingChecks(checks);
  assert.match(line ?? '', /amended since you recorded \*\*passed\*\*/);

  const comment = renderPlanComment(system.store.getPlanByOrigin('issue:12')!, [], '#', checks);
  assert.match(comment, /amended after it was passed/);

  const fresh = build();
  const other = planWith(fresh, [check()]);
  planWith(fresh, [check({ expect: 'It opens as a workbook.' })]);
  assert.doesNotMatch(outstandingChecks(checksOf(fresh, other))[0] ?? '', /amended/);
});
