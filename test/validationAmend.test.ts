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
import { renderPlanComment } from '../src/plans/planComment.js';
import type { Agent, ValidationCheck } from '../src/types.js';

/**
 * `validation_amend`: correcting a validation plan while the work is being done.
 *
 * The property every test here circles is the one that separates this transport
 * from `plan_submit`'s: **an amendment speaks only for what it names.** A plan
 * document declares the whole check set, so silence in it is a withdrawal; a
 * correction written by an agent halfway through part three knows about one check
 * and nothing about the other eight, and reading its silence the same way would
 * mean an agent deletes a validation plan by being terse.
 *
 * The second is the cost of a rewording, asserted in **both** directions: a check
 * whose wording changed loses the result somebody recorded, and one re-declared
 * word for word keeps it. Those are one edit apart and only one of them is honest.
 */

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

/** A plan with the given checks already declared, and its id. */
function planWith(
  system: System,
  checks: Record<string, unknown>[],
  resources: Record<string, unknown>[] = [],
): string {
  const parsed = validatePlanDocument({
    version: 1,
    verdict: 'single',
    reason: 'One small fix.',
    validation: { checks, resources },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: 'issue:12', title: 'Ship it' });
  // The **goal**, which is what the checks are keyed on — the plan id is not a
  // handle anything about validation takes any more.
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

// -- who may amend -----------------------------------------------------------

test('the agent doing the work may amend; the planner is refused and told where to go', async () => {
  const system = build();
  planWith(system, [check()]);

  // Wider than the other origin fences on purpose: a check is not a verdict, and
  // the agent best placed to notice one is wrong is whoever is looking at the
  // code. All three of these are working this goal.
  for (const origin of ['issue:12', 'issue:12:part:reader', 'issue:12:assess']) {
    const res = await callTool(system, spawnAgent(system, origin), 'validation_amend', {
      note: 'the command was renamed',
      checks: [check({ id: `from-${origin.replace(/[^a-z]+/g, '-')}`, title: 'A new check' })],
    });
    assert.equal(res.isError, false, `${origin} may amend its own goal's validation plan`);
  }

  // Refused *by name*, `conclusionOrigin`'s discipline: a planner handed a
  // success would have used the one transport whose silence does not withdraw,
  // believing it had spoken for the whole set.
  const planner = await callTool(system, spawnAgent(system, 'issue:12:plan'), 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'planner-check' })],
  });
  assert.equal(planner.isError, true);
  assert.match(planner.text, /plan_submit/);

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
  // There is no issue argument to get wrong: the tool reads the origin off the
  // task the credential resolved to, so this lands on #99's plan or on nothing.
  const res = await callTool(system, spawnAgent(system, 'issue:99'), 'validation_amend', {
    note: 'nothing to do with #12',
    checks: [check({ id: 'elsewhere' })],
  });
  assert.equal(res.isError, true);
  assert.equal(checksOf(system, plan).length, 1);
});

// -- merge-only, which is the whole difference from an ingestion --------------

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

  // The failure this guards: reading the amendment's silence about b and c the
  // way `ingestValidation` reads a document's would supersede both, and a
  // terse-but-correct correction would have deleted two thirds of the plan.
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
  // After the last, not at the top: an amendment has no document order of its
  // own, so taking the position from its own list would file a one-check
  // correction ahead of the checks it was written to sit beside.
  assert.equal(added.seq, 3);
  // Banded, because it appeared after the operator read the plan — with no prior
  // wording, since there is none.
  assert.ok(added.amendedAt);
  assert.equal(added.revision, null);
  assert.match(added.amendNote ?? '', /nothing checked the empty case/);
});

// -- what a rewording costs, both directions ---------------------------------

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
  // Told out loud rather than left to be inferred from a silent success: this is
  // the one consequence of the call the agent did not ask for.
  assert.match(JSON.stringify(body.withdrewResults), /was passed, now unrun/);

  const after = byId(system, plan, 'csv-opens');
  assert.equal(after.state, 'unrun');
  assert.equal(after.resultNote, null);
  assert.equal(after.letter, 'A', 'the handle survives — 12:A is the same check');
  // The record of what was withdrawn, which is what lets the operator judge
  // whether the pass still means anything.
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
    // Same title, do and expect; only the bibliography moved. A plan that fixed a
    // mistyped resource name has not changed what a pass means.
    checks: [check({ covers: ['reader'], fleetCandidate: true, why: 'it is a command-line check' })],
  });
  assert.deepEqual(res.json().unchanged, ['csv-opens']);

  const after = byId(system, plan, 'csv-opens');
  assert.equal(after.state, 'passed');
  assert.equal(after.resultNote, 'ran it');
  // No band: nothing an operator needs telling about. A band here would make one
  // tidied reference shout as loudly as a rewritten expectation.
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
  // `unrun` is not a reading, so nothing was withdrawn and the band must not say
  // one was. This is what keeps "a result was taken from you" meaningful.
  assert.equal(after.revision?.state, null);
});

// -- withdrawal --------------------------------------------------------------

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
  // Attributed, `outstandingWorkNote`'s discipline: an operator must not read an
  // agent's account of why a check went as the harness's own.
  assert.match(gone.supersededReason ?? '', /An agent working this goal withdrew this check/);
  assert.match(gone.supersededReason ?? '', /no longer being built/);

  // And the letter stays taken, which is the whole reason the row is kept: `12:B`
  // must not come to mean a different check next week.
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
  // Reported as an addition, because from the operator's side that is the news:
  // this check is being asked for and was not.
  assert.deepEqual(res.json().added, ['B. b']);
  const back = byId(system, plan, 'b');
  assert.equal(back.supersededReason, null);
  assert.equal(back.letter, 'B');
  assert.ok(back.amendedAt, 'and it is banded, because it reappeared');
});

// -- what a correction may say -----------------------------------------------

test('an amendment is parsed by the plan document schema, so it refuses what that refuses', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  const agent = spawnAgent(system, 'issue:12');

  // The refusal that matters most: who runs a check is not the author's to say,
  // and an amendment that could quietly assign one would reintroduce exactly what
  // `.strict()` was added to the document schema to stop.
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

  // Both refusals are total: nothing was written, so the caller retries against
  // an unchanged check set rather than a half-applied one.
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

  // An amendment that changes nothing is refused rather than accepted quietly:
  // the caller believes it corrected something and would go on believing it.
  const empty = await callTool(system, agent, 'validation_amend', { note: 'thinking about it' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /at least one check/);

  // Both readings are defensible and the caller means one of them, so it is
  // refused rather than resolved.
  const both = await callTool(system, agent, 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'a' })],
    withdraw: [{ id: 'a', reason: 'r' }],
  });
  assert.equal(both.isError, true);
  assert.match(both.text, /both declared and withdrawn/);
});

// -- resources ---------------------------------------------------------------

test('an amendment adds resources and removes none, and an unprovided one becomes an ask', async () => {
  const system = build();
  const plan = planWith(
    system,
    [check({ uses: ['seed.sql'] })],
    [{ name: 'seed.sql', kind: 'fixture', note: 'the seeded database' }],
  );

  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'the new check needs a login',
    resources: [{ name: 'staging login', kind: 'access', provided: false }],
    // Names the resource the *planner* declared, not one this amendment carries:
    // pruning `uses` against the amendment alone would drop a live reference.
    checks: [check({ id: 'login-works', title: 'A staging login still works', uses: ['seed.sql', 'staging login'] })],
  });
  assert.equal(res.isError, false);

  const names = system.store.listValidationResources(plan).map((r) => r.name);
  assert.deepEqual(names.sort(), ['seed.sql', 'staging login']);
  assert.deepEqual(byId(system, plan, 'login-works').uses.sort(), ['seed.sql', 'staging login']);

  // An ask rather than a check that mysteriously never runs.
  const asks = system.store.listHumanTasks().filter((t) => t.title.includes('staging login'));
  assert.equal(asks.length, 1);
  assert.match(asks[0]!.detail ?? '', /could not produce it/);
});

// -- the two ways it can be off ----------------------------------------------

test('with no plan the tool refuses rather than pretending', async () => {
  // The checks hang off the plan row, so a goal whose planner has not written one
  // yet has nowhere to put a check. Said plainly rather than dressed up as a
  // permission problem — it is neither the agent's fault nor something it can fix.
  const system = build();
  const noPlan = await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'n',
    checks: [check({ id: 'x' })],
  });
  assert.equal(noPlan.isError, true);
  assert.match(noPlan.text, /has no plan/);
});

// -- the band, and how it clears ---------------------------------------------

test('the band clears when the operator records a reading against the new wording', async () => {
  const system = build();
  const plan = planWith(system, [check()]);
  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it', by: 'operator' });
  await callTool(system, spawnAgent(system, 'issue:12'), 'validation_amend', {
    note: 'it is XLSX now',
    checks: [check({ expect: 'It opens as a workbook.' })],
  });
  assert.ok(byId(system, plan, 'csv-opens').amendedAt);

  // The only acknowledgement worth having: the operator ran the check as it now
  // reads. A dismiss button would clear it for somebody who had merely seen it.
  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it again', by: 'operator' });
  const after = byId(system, plan, 'csv-opens');
  assert.equal(after.amendedAt, null);
  assert.equal(after.revision, null);
  assert.equal(after.amendNote, null);
});

test('a replan bands what it changed, and a plan first declaring its checks bands nothing', () => {
  const system = build();
  const plan = planWith(system, [check({ id: 'a' }), check({ id: 'b', title: 'Second' })]);
  // A plan's *opening* block is a declaration, not an amendment. Banding it would
  // fire the one signal that means "this is not the check you read" on a plan
  // nobody has read yet.
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

// -- and where the operator hears about it -----------------------------------

test('a withdrawn reading is stated off the cockpit too — on the close-out and on the ticket', () => {
  const system = build();
  const plan = planWith(system, [check()]);
  system.store.recordValidationResult(plan, 'csv-opens', { state: 'passed', note: 'ran it', by: 'operator' });
  planWith(system, [check({ expect: 'It opens as a workbook.' })]);
  const checks = checksOf(system, plan);

  // Without this the line reads "A. **The export opens in Excel** — unrun",
  // which is indistinguishable from a check nobody got to — and this is the case
  // where somebody *did* the work.
  const [line] = outstandingChecks(checks);
  assert.match(line ?? '', /amended since you recorded \*\*passed\*\*/);

  const comment = renderPlanComment(system.store.getPlanByOrigin('issue:12')!, [], checks);
  assert.match(comment, /amended after it was passed/);

  // The other direction: a check nobody had run says nothing extra, because an
  // amendment to one took nothing away.
  const fresh = build();
  const other = planWith(fresh, [check()]);
  planWith(fresh, [check({ expect: 'It opens as a workbook.' })]);
  assert.doesNotMatch(outstandingChecks(checksOf(fresh, other))[0] ?? '', /amended/);
});
