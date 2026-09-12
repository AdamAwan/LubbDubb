import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { RemoteReadingDesk } from '../src/remoteValidation/readings.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { remoteRunBriefs, runnableScreens, runnableScripts } from '../src/remoteValidation/briefing.js';
import { sheetRows } from '../src/remoteValidation/sheet.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { checkBriefing } from '../src/validation/fleet.js';
import { stepScript, sweptScripts } from '../src/validation/steps.js';
import { validationVerdict } from '../src/validation/verdict.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Agent, ValidationCheck, ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * The two missing readings: the **one-off script** — the browser-shaped member of the query column,
 * which acts, may go green on its own and is attributed `script` and never `spec` — and the
 * **screenshot handback**, which captures and asserts nothing and reaches a state of its own.
 *
 * → docs/spec/36-remote-validation.md#the-one-off-script
 * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
 */

const GOAL = 'issue:12';
const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** A browser suite **and** a tenant: the two a one-off script needs, because it acts. */
const TENANTED: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: {
    permits: ['check'],
    tenant: 'validation-customer-1',
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' },
  },
};

/** The same environment with the tenant taken out — the one thing a script cannot do without. */
const TENANTLESS: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: {
    permits: ['check'],
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' },
  },
};

const SCRIPT = "await page.goto('/orders');\nawait expect(page.getByRole('row')).toHaveCount(1);";

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(environments: EnvironmentConfig[]): { system: System; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vscript-'));
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      validationRoot: join(dir, 'validation'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      environments,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
      // A `validate` block spawns the project's own commands against a deployed store and
      // provisions tenants in it; a `validate.browser` block drives a browser at it.
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      remoteRunner: new FakeRemoteRunner({}),
    },
  );
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });
  return { system, dir };
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Ship it',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function plan(system: System, checks: unknown[]): Promise<{ isError: boolean; text: string }> {
  const agent = spawnAgent(system, 'issue:12:validate-plan');
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session.call('validation_plan', { note: 'followed the hint', checks })) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const BASE = {
  id: 'an-order-places',
  title: 'An order still places',
  do: 'Place one.',
  expect: 'It places.',
};

function only(system: System): ValidationCheck {
  const check = system.store.validation.listValidationChecks(GOAL)[0];
  assert.ok(check !== undefined, 'the goal carries exactly one check');
  return check;
}

// ------------------------------------------------------------- the one-off script, as authored

test('a one-off script rides a browser step, and rides nothing else', async () => {
  const { system, dir } = build([TENANTED]);
  const good = await plan(system, [{ ...BASE, steps: [{ kind: 'browser', do: 'Place an order', script: SCRIPT }] }]);
  assert.equal(good.isError, false, good.text);

  const check = only(system);
  assert.equal(stepScript(check.steps), SCRIPT, 'the source is kept on the step, which is where it is drawn');
  assert.equal(check.steps[0]?.actor, 'fleet', 'the browser block and the tenant are both declared');
  assert.equal(check.area, null, 'a script is not a suite area, and neither stands in for the other');

  // A `suite` step's script would be a second, unreviewed body of code wearing a reviewed step's
  // clothes; a `screenshot` step's would be an assertion on the one kind that must never assert.
  for (const kind of ['suite', 'screenshot', 'state', 'manual'] as const) {
    const bad = await plan(system, [
      {
        ...BASE,
        id: `on-a-${kind}-step`,
        steps: [{ kind, do: 'x', script: 'nope', ...(kind === 'suite' ? { area: 'checkout' } : {}) }],
      },
    ]);
    assert.equal(bad.isError, true, `a ${kind} step must not carry a script`);
    assert.match(bad.text, /script/, bad.text);
  }
  system.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('the check briefing prints the script and says it is not this dispatch’s to run', async () => {
  const { system, dir } = build([TENANTED]);
  const res = await plan(system, [{ ...BASE, steps: [{ kind: 'browser', do: 'Place an order', script: SCRIPT }] }]);
  assert.equal(res.isError, false, res.text);

  const briefing = checkBriefing(only(system));
  assert.match(briefing, /one-off script/);
  assert.ok(briefing.includes(SCRIPT), 'the source is printed, because reading it is cheaper than trusting it');
  assert.match(briefing, /do not run it from this dispatch/i, 'it acts, so it runs under the sheet’s tenant machinery');
  system.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('a script check with no tenant is blocked naming the command or variable that would provide one', async () => {
  const { system, dir } = build([TENANTLESS]);
  const res = await plan(system, [{ ...BASE, steps: [{ kind: 'browser', do: 'Place an order', script: SCRIPT }] }]);
  assert.equal(res.isError, false, res.text);
  const check = only(system);
  // With no tenant the step itself already comes back to a person, naming the three shapes.
  assert.equal(check.steps[0]?.actor, 'human');
  assert.match(check.steps[0]?.why ?? '', /validate\.tenantEnv/);

  const blocked = sheetRows({
    environment: TENANTLESS,
    checks: [{ ...check, steps: [{ ...check.steps[0]!, actor: 'fleet', why: null }] }],
    watches: [],
    queries: [],
    approvals: new Set(),
    tenant: { tenant: null, blockedReason: null },
  })[0];
  assert.match(blocked?.blockedReason ?? '', /validate\.tenant/, 'it names the line the operator has not written');
  assert.match(blocked?.blockedReason ?? '', /validate\.ensureTenant/);
  assert.doesNotMatch(blocked?.blockedReason ?? '', /generated|invented tenant name is/i);

  const fine = sheetRows({
    environment: TENANTED,
    checks: [check],
    watches: [],
    queries: [],
    approvals: new Set(),
    tenant: { tenant: 'validation-customer-1', blockedReason: null },
  })[0];
  assert.equal(fine?.blockedReason, null, 'a tenant is declared, so the script has somewhere to act');
  system.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// --------------------------------------------------------------- the one-off script, as run

interface Bench {
  dir: string;
  store: Store;
  reading: RemoteReadingDesk;
  runId: string;
  /** Every capture the desk moved out of the run's artefacts, as `[from, to]`. */
  kept: [string, string][];
}

const SCRIPT_STEP: ValidationStep = {
  kind: 'browser',
  do: 'Place an order',
  area: null,
  when: 'inline',
  script: SCRIPT,
  scriptSweptAt: null,
  actor: 'fleet',
  why: null,
};

const SCREEN_STEP: ValidationStep = {
  kind: 'screenshot',
  do: 'Capture the confirmation screen',
  area: null,
  when: 'inline',
  script: null,
  scriptSweptAt: null,
  actor: 'fleet',
  why: null,
};

function scriptBench(over: { steps?: ValidationStep[]; area?: string | null } = {}): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vrun-'));
  const store = new Store(join(dir, 'harness.sqlite'));
  const kept: [string, string][] = [];
  const input: ValidationCheckInput = {
    ...BASE,
    ...(over.area === undefined ? {} : { area: over.area }),
    seq: 1,
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    steps: over.steps ?? [SCRIPT_STEP],
  };
  store.validation.ingestValidation(GOAL, { checks: [input], resources: [], supersededReason: '', amendNote: '' });
  store.remoteValidation.openRemoteSheet({ goalRef: GOAL, environment: 'acceptance' });
  store.remoteValidation.saveRemoteSheetRows(GOAL, 'acceptance', [
    {
      rowId: `check:${BASE.id}`,
      kind: 'check',
      seq: 1,
      title: BASE.title,
      sourceId: BASE.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
    },
  ]);
  const { run } = store.remoteValidation.beginRemoteRun({
    goalRef: GOAL,
    environment: 'acceptance',
    tenant: 'validation-customer-1',
    startedSha: 'abc1234',
  });
  assert.ok(run !== null, 'nothing else holds this environment and tenant');
  const reading = new RemoteReadingDesk({
    store,
    environments: [TENANTED],
    prober: new FakeEnvironmentProber({ acceptance: ['abc1234'] }),
    validationRoot: dir,
    read: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
    keep: async (from, to) => {
      kept.push([from, to]);
    },
  });
  return { dir, store, reading, runId: run.id, kept };
}

function report(dir: string, rows: unknown[]): string {
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(rows));
  return path;
}

test('a script’s reading is attributed script, never spec, and the two never overwrite each other', async () => {
  const bench = scriptBench();
  const settled = await bench.reading.settle(bench.runId, {
    reportPath: report(bench.dir, [{ selector: BASE.id, status: 'passed', retries: 0, durationMs: 12 }]),
    artefacts: null,
  });
  assert.ok(settled.ok, 'ok' in settled ? '' : String(settled));
  assert.ok(settled.ok && settled.wrote === 1, 'the script wrote its reading onto the check');

  const check = bench.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(check?.state, 'passed', 'a one-off script may assert and go green on its own');
  assert.equal(check?.resultBy, 'script', 'never `spec` — nothing reviewed it');
  assert.match(check?.resultNote ?? '', /one-off script/, 'the sheet says which instrument earned the green');

  bench.store.close();
  rmSync(bench.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('a script that reported nothing under its own id is blocked, never passed', async () => {
  const bench = scriptBench();
  const settled = await bench.reading.settle(bench.runId, {
    reportPath: report(bench.dir, [{ selector: 'something-else', status: 'passed' }]),
    artefacts: null,
  });
  assert.ok(settled.ok, 'ok' in settled ? '' : String(settled));
  assert.ok(settled.ok && settled.blocked === 1 && settled.wrote === 0);
  assert.equal(
    bench.store.validation.listValidationChecks(GOAL)[0]?.state,
    'unrun',
    'nothing was learned, so nothing is written',
  );
  const row = bench.store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `check:${BASE.id}`);
  assert.match(row?.detail ?? '', /reported nothing under its own id/);
  bench.store.close();
  rmSync(bench.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('a run whose only confirmed check carries a script still owes an agent, and briefs it with the source', () => {
  const bench = scriptBench();
  const scripts = runnableScripts(bench.store, TENANTED, GOAL, bench.store.remoteValidation.listRemoteSheetRows());
  assert.deepEqual(
    scripts.map((s) => s.checkId),
    [BASE.id],
    'it names no selector, so a press counting selectors alone would settle with its browser half owed',
  );

  const brief = remoteRunBriefs({
    store: bench.store,
    environments: [TENANTED],
    validationRoot: join(bench.dir, 'validation'),
    now: () => NOW,
  })[0];
  assert.equal(brief?.confirmed, 1);
  assert.ok(brief?.briefing.includes(SCRIPT), 'the agent is handed the source, appended and never interpolated');
  assert.match(brief?.briefing ?? '', /reports under the check’s own id/);
  assert.match(brief?.briefing ?? '', /validation-customer-1/, 'and the tenant it acts inside');
  bench.store.close();
  rmSync(bench.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ------------------------------------------------------------------------ the grace period

test('the grace sweep removes a script past its window, names where it was, and leaves a fresh goal alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vsweep-'));
  const store = new Store(join(dir, 'harness.sqlite'));
  const input: ValidationCheckInput = {
    ...BASE,
    seq: 1,
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    steps: [
      {
        kind: 'browser',
        do: 'Place an order',
        area: null,
        when: 'inline',
        script: SCRIPT,
        scriptSweptAt: null,
        actor: 'fleet',
        why: null,
      },
    ],
  };
  for (const goal of ['issue:12', 'issue:13'])
    store.validation.ingestValidation(goal, { checks: [input], resources: [], supersededReason: '', amendNote: '' });
  const delivery = (originRef: string, at: number): void => {
    const db = new Database(join(dir, 'harness.sqlite'));
    try {
      store.verdicts.recordDelivery({ originRef, summary: 'every part merged', detail: null, by: 'assessor' });
      db.prepare(`UPDATE issue_deliveries SET decided_at=? WHERE origin_ref=?`).run(
        new Date(at).toISOString(),
        originRef,
      );
    } finally {
      db.close();
    }
  };
  delivery('issue:12', NOW - GRACE_MS - 1000);
  delivery('issue:13', NOW - 1000);

  const desk = new RemoteValidationDesk({
    store,
    environments: [TENANTED],
    observer: new FakeEnvironmentObserver(),
    queries: new StateQueryDesk({ store, environments: [TENANTED], reader: new FakeStateReader({}) }),
    runner: new FakeRemoteRunner({}),
    scriptGraceMs: GRACE_MS,
    probeIntervalMs: 60_000,
    now: () => NOW,
  });
  await desk.run();

  const swept = store.validation.listValidationChecks('issue:12')[0]?.steps[0];
  assert.equal(swept?.script, null, 'a one-off that survives its goal is a second suite grown by accident');
  assert.equal(
    swept?.scriptSweptAt,
    new Date(NOW).toISOString(),
    'and the sweep names what it removed, where the source was',
  );

  const fresh = store.validation.listValidationChecks('issue:13')[0]?.steps[0];
  assert.equal(fresh?.script, SCRIPT, 'a goal inside its grace period keeps its script');
  assert.equal(fresh?.scriptSweptAt, null);

  // Nothing else on the row moved: removing a source says nothing about whether the check passed.
  assert.equal(store.validation.listValidationChecks('issue:12')[0]?.state, 'unrun');
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('sweptScripts writes nothing where there is nothing to remove', () => {
  const step = {
    kind: 'suite' as const,
    do: 'run it',
    area: 'checkout',
    when: 'inline' as const,
    script: null,
    scriptSweptAt: null,
    actor: 'fleet' as const,
    why: null,
  };
  assert.equal(sweptScripts([step], new Date(NOW).toISOString()), null);
});

// ------------------------------------------------------------------ the screenshot handback

test('a captured report attaches the screen, states no outcome, and never goes green on its own', async () => {
  const { system, dir } = build([TENANTED]);
  const res = await plan(system, [
    { ...BASE, steps: [{ kind: 'screenshot', do: 'Capture the orders grid at 1280px' }] },
  ]);
  assert.equal(res.isError, false, res.text);
  system.store.validation.setValidationActor(GOAL, BASE.id, 'fleet');

  const agent = spawnAgent(system, `issue:12:validate:${BASE.id}`);
  const session = system.mcp.session(agent.id);
  assert.ok(session);
  const reported = (await session.call('validation_report', {
    result: 'captured',
    note: 'The grid at 1280px, with the third column truncated.',
    capture: 'orders-grid.png',
  })) as ToolResultText;
  assert.notEqual(reported.isError, true, reported.content[0]?.text ?? '');

  const check = only(system);
  assert.equal(check.state, 'captured', 'it does not go green, and it does not sit unrun either');
  assert.equal(check.capture, 'orders-grid.png');
  assert.equal(check.resultBy, 'agent');
  assert.equal(validationVerdict([check]).state, 'flagged', 'a capture settles nothing');
  assert.equal(validationVerdict([check]).captured, 1, 'and is counted apart from `unrun`, which is a different ask');

  // A person judges it, and their reading keeps the image they judged: clearing the capture there
  // would delete the evidence at the exact moment somebody is acting on it.
  const judged = system.store.validation.recordValidationResult(GOAL, BASE.id, {
    state: 'passed',
    note: 'The truncation is fine.',
    by: 'operator',
  });
  assert.equal(judged?.state, 'passed');
  assert.equal(judged?.resultBy, 'operator');
  assert.equal(judged?.capture, 'orders-grid.png');

  const reset = system.store.validation.recordValidationResult(GOAL, BASE.id, { state: 'unrun', note: null, by: null });
  assert.equal(reset?.capture, null, 'a reset means nothing to attribute, and that includes the image');
  system.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('a row written before the state existed reads unrun, not captured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vstate-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  store.validation.ingestValidation(GOAL, {
    checks: [{ ...BASE, seq: 1, uses: [], covers: [], fleetCandidate: false, candidateWhy: null }],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  const db = new Database(file);
  try {
    // What a build that never heard of `captured` would leave, and what an unrecognised word is.
    db.prepare(`UPDATE validation_checks SET state=? WHERE origin_ref=?`).run('something-else', GOAL);
  } finally {
    db.close();
  }
  assert.equal(
    store.validation.listValidationChecks(GOAL)[0]?.state,
    'unrun',
    'unrecognised narrows to unrun, never to captured',
  );
  assert.deepEqual(
    (() => {
      const check = store.validation.getValidationCheck(GOAL, BASE.id);
      return [check?.state, check?.capture];
    })(),
    ['unrun', null],
    'and the column it would have carried is null on every row from before it',
  );
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ----------------------------------------------- the screen the sheet's own run hands back

test('a screenshot check runs on the sheet, and its screen is kept with the goal rather than the run', async () => {
  const bench = scriptBench({ steps: [SCREEN_STEP] });
  const settled = await bench.reading.settle(bench.runId, {
    reportPath: report(bench.dir, [
      { selector: BASE.id, status: 'skipped', capture: 'confirmation.png' },
      { selector: 'Checkout', status: 'passed' },
    ]),
    artefacts: 'https://example.test/run',
  });
  assert.ok(settled.ok, 'ok' in settled ? '' : String(settled));
  assert.ok(settled.ok && settled.captured === 1, 'the run handed one screen back');

  const check = bench.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(check?.state, 'captured', 'a screen never colours its own row — a person judges it');
  assert.equal(check?.resultBy, 'agent', 'nothing asserted, so there is no instrument to attribute');
  assert.match(check?.capture ?? '', /^capture-/, 'the harness names what it kept, not the report');
  assert.doesNotMatch(check?.capture ?? '', /[\\/]/, 'a capture is a file name, never a path');

  const [from, to] = bench.kept[0] ?? ['', ''];
  assert.match(from, /artefacts[\\/]confirmation\.png$/, 'it is taken out of this run’s artefacts');
  assert.match(to, /issue-[^\\/]*[\\/]capture-/, 'and kept in the goal’s own validation directory');

  const row = bench.store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `check:${BASE.id}`);
  assert.equal(row?.outcome, 'captured', 'the sheet row says the same thing the check does');
  bench.store.close();
});

test('a screenshot check that came back without a screen is blocked, never passed', async () => {
  const bench = scriptBench({ steps: [SCREEN_STEP] });
  const settled = await bench.reading.settle(bench.runId, {
    reportPath: report(bench.dir, [{ selector: BASE.id, status: 'passed' }]),
    artefacts: null,
  });
  assert.ok(settled.ok && settled.blocked === 1, 'handing the screen back is the whole of what the step is for');
  assert.equal(
    bench.store.validation.listValidationChecks(GOAL)[0]?.state,
    'unrun',
    'and nothing is written onto the check',
  );
  assert.deepEqual(bench.kept, [], 'there was nothing to keep');
  const row = bench.store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `check:${BASE.id}`);
  assert.match(row?.detail ?? '', /names none under its id/);
  bench.store.close();
});

test('a capture named as a path or a URL is refused, and the row says which', async () => {
  for (const name of ['../../etc/passwd', 'https://example.test/shot.png']) {
    const bench = scriptBench({ steps: [SCREEN_STEP] });
    const settled = await bench.reading.settle(bench.runId, {
      reportPath: report(bench.dir, [{ selector: BASE.id, status: 'skipped', capture: name }]),
      artefacts: null,
    });
    assert.ok(settled.ok && settled.blocked === 1, `"${name}" is not a file name`);
    assert.deepEqual(bench.kept, [], 'and nothing is moved on the strength of it');
    assert.equal(bench.store.validation.listValidationChecks(GOAL)[0]?.capture, null);
    bench.store.close();
  }
});

test('a screen beside a suite assertion keeps the spec attribution, and a red is never withheld for it', async () => {
  const passing = scriptBench({ steps: [SCREEN_STEP], area: 'Checkout' });
  await passing.reading.settle(passing.runId, {
    reportPath: report(passing.dir, [
      { selector: 'Checkout', status: 'passed' },
      { selector: BASE.id, status: 'skipped', capture: 'grid.png' },
    ]),
    artefacts: null,
  });
  const held = passing.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(held?.state, 'captured', 'the suite passed, but nobody has looked at the screen yet');
  assert.equal(held?.resultBy, 'spec', 'the reviewed instrument keeps its own word — the two are never folded');
  passing.store.close();

  const failing = scriptBench({ steps: [SCREEN_STEP], area: 'Checkout' });
  await failing.reading.settle(failing.runId, {
    reportPath: report(failing.dir, [
      { selector: 'Checkout', status: 'failed' },
      { selector: BASE.id, status: 'skipped', capture: 'grid.png' },
    ]),
    artefacts: null,
  });
  const red = failing.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(red?.state, 'failed', 'a red the product earned is not withheld for want of a picture');
  assert.match(red?.resultNote ?? '', /screen was handed back/, 'and the screen rides it as evidence');
  assert.match(red?.capture ?? '', /^capture-/);
  failing.store.close();
});

test('a run whose only confirmed check hands a screen back still owes an agent, and is told to take it', () => {
  const bench = scriptBench({ steps: [SCREEN_STEP] });
  const screens = runnableScreens(bench.store, TENANTED, GOAL, bench.store.remoteValidation.listRemoteSheetRows());
  assert.deepEqual(
    screens.map((s) => s.checkId),
    [BASE.id],
    'it names no selector and carries no script, so counting the two instruments settles a run with its point owed',
  );

  const brief = remoteRunBriefs({
    store: bench.store,
    environments: [TENANTED],
    validationRoot: join(bench.dir, 'validation'),
    now: () => NOW,
  })[0];
  assert.equal(brief?.confirmed, 1);
  assert.match(brief?.briefing ?? '', /a screenshot \*\*asserts nothing\*\*/, 'and the agent is told not to judge it');
  assert.match(brief?.briefing ?? '', /file name only/, 'nor to hand back a path');
  bench.store.close();
  rmSync(bench.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
