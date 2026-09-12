import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { VALIDATION_COLUMNS } from '../src/store/validation.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { checkBriefing } from '../src/validation/fleet.js';
import { fleetCanStart, segmentBoundary, stepCapabilities } from '../src/validation/steps.js';
import { validationCheckSetInputs } from '../src/validation/checkDocument.js';
import { sheetRows } from '../src/remoteValidation/sheet.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Agent, ValidationCheck } from '../src/types.js';

/*
 * A check's test plan: one ordered journey through the delivered goal, each step assigned off what
 * the deployment declares rather than guessed, and an inline person's step segmenting the run.
 *
 * → docs/spec/20-validation.md#the-test-plan
 */

const GOAL = 'issue:12';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Everything a step can be carried by: a browser suite, a tenant, a deployed store, an observer. */
const FULL: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  watch: { observe: 'echo {}' },
  validate: {
    permits: ['check', 'state'],
    tenant: 'validation',
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' },
    state: { run: 'npm run state' },
  },
};

/** A browser suite and nothing else — no tenant, no store reader, no observer. */
const BROWSER_ONLY: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: {
    permits: ['check'],
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' },
  },
};

function build(environments: EnvironmentConfig[]): System {
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
      environments,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
      // A `validate` block spawns the project's own commands against a deployed store, and a
      // `validate.browser` block drives a browser at somebody's acceptance environment.
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      remoteRunner: new FakeRemoteRunner({}),
    },
  );
}

function ingest(system: System): void {
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });
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
  const result = (await session.call('validation_plan', {
    note: 'followed the hint',
    checks,
  })) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

function fleetCheck(steps: ValidationCheck['steps']): ValidationCheck {
  return {
    originRef: GOAL,
    id: 'an-order-places',
    letter: 'A',
    seq: 1,
    title: 'An order still places',
    do: 'Place one.',
    expect: 'It places.',
    uses: [],
    covers: [],
    steps,
    capture: null,
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'fleet',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    area: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A delivered goal, parked, carrying one check the operator handed to the fleet. */
function ctx(steps: ValidationCheck['steps']): DispatchContext {
  return {
    world: {
      takenAt: NOW,
      pullRequests: [],
      issues: [
        {
          id: 'i12',
          number: 12,
          title: 'Ship it',
          body: 'please add the thing',
          labels: [],
          state: 'open',
          linkedPrNumber: null,
        },
      ],
    },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    deliveries: [
      {
        originRef: GOAL,
        summary: 'every part merged',
        detail: null,
        by: 'assessor',
        agentId: 'a1',
        taskId: 't1',
        decidedAt: NOW,
        updatedAt: NOW,
      },
    ],
    validationChecks: [fleetCheck(steps)],
  };
}

const NOW = '2026-01-01T00:00:00.000Z';

const CHECK = {
  id: 'an-order-places',
  title: 'An order still places end to end',
  do: 'Place one against acceptance.',
  expect: 'It places, the row is written, nothing is in the error log.',
};

// ------------------------------------------------- assignment off the configuration

test('a step is the fleet’s where the configuration declares what carries it, and a person’s where it does not', async () => {
  const system = build([FULL]);
  ingest(system);
  const res = await plan(system, [
    {
      ...CHECK,
      steps: [
        { kind: 'suite', do: 'Run the checkout area', area: 'Checkout Tests' },
        { kind: 'browser', do: 'Place an order through the new confirmation step' },
        { kind: 'state', do: 'Read the order row back' },
        { kind: 'signal', do: 'Check nothing is in the error log' },
      ],
    },
  ]);
  assert.equal(res.isError, false, res.text);

  const check = system.store.validation.listValidationChecks(GOAL)[0];
  assert.deepEqual(
    check?.steps.map((s) => [s.kind, s.actor]),
    [
      ['suite', 'fleet'],
      ['browser', 'fleet'],
      ['state', 'fleet'],
      ['signal', 'fleet'],
    ],
    'everything this deployment declares, it carries',
  );
  assert.deepEqual(
    check?.steps.map((s) => s.why),
    [null, null, null, null],
    'and a step the fleet carries needs no account of itself',
  );
  system.store.close();
});

test('a step nothing declares comes back to a person, naming the configuration that would have carried it', async () => {
  const system = build([BROWSER_ONLY]);
  ingest(system);
  const res = await plan(system, [
    {
      ...CHECK,
      steps: [
        { kind: 'suite', do: 'Run the checkout area', area: 'Checkout Tests' },
        { kind: 'browser', do: 'Place an order' },
        { kind: 'state', do: 'Read the order row back' },
        { kind: 'measure', do: 'Read the order-rate metric' },
      ],
    },
  ]);
  assert.equal(res.isError, false, res.text);

  const steps = system.store.validation.listValidationChecks(GOAL)[0]?.steps ?? [];
  assert.deepEqual(
    steps.map((s) => [s.kind, s.actor]),
    [
      ['suite', 'fleet'],
      ['browser', 'human'],
      ['state', 'human'],
      ['measure', 'human'],
    ],
    'the browser block carries the suite run; a browser step also acts, and nothing names a tenant',
  );
  assert.match(steps[1]?.why ?? '', /tenant/, 'the harness never generates or infers one, so it says which to declare');
  assert.match(steps[2]?.why ?? '', /validate\.state\.run/);
  assert.match(steps[3]?.why ?? '', /watch\.observe/);
  system.store.close();
});

test('with nothing configured every step is a person’s, which is the direction this has to fail in', () => {
  const caps = stepCapabilities([]);
  assert.deepEqual(caps, { browser: false, state: false, observe: false, tenant: false });

  const written = validationCheckSetInputs(
    [
      {
        ...CHECK,
        uses: [],
        covers: [],
        fleetCandidate: false,
        steps: [{ kind: 'browser' as const, do: 'click' }],
      },
    ],
    [],
    [],
    caps,
  );
  assert.equal(written[0]?.steps?.[0]?.actor, 'human', 'a step given to a fleet that cannot carry it is lost silently');
});

// -------------------------------------------------------- the segment boundary

test('an inline person’s step segments the check and a deferred one does not', () => {
  const step = (over: Partial<ValidationCheck['steps'][number]>): ValidationCheck['steps'][number] => ({
    kind: 'browser',
    do: 'x',
    area: null,
    when: 'inline',
    script: null,
    scriptSweptAt: null,
    actor: 'fleet',
    why: null,
    ...over,
  });

  assert.equal(segmentBoundary([step({}), step({})]), null, 'an all-fleet plan has nowhere to stop');
  assert.equal(
    segmentBoundary([step({}), step({ kind: 'screenshot', actor: 'human', when: 'deferred' })]),
    null,
    'somebody looks at it afterwards — the run completes, and it costs the sequence nothing',
  );
  assert.equal(
    segmentBoundary([step({}), step({ kind: 'manual', actor: 'human', when: 'inline' })]),
    1,
    'the run stops there: no agent holds a session across a person’s day',
  );
});

test('a check dispatched across a boundary is told to stop at it and hand back with what it has', () => {
  const system = build([FULL]);
  ingest(system);
  const check: ValidationCheck = {
    originRef: GOAL,
    id: 'an-order-places',
    letter: 'A',
    seq: 1,
    title: 'An order still places',
    do: 'Place one.',
    expect: 'It places.',
    uses: [],
    covers: [],
    steps: [
      {
        kind: 'browser',
        do: 'Fill the basket',
        area: null,
        when: 'inline',
        script: null,
        scriptSweptAt: null,
        actor: 'fleet',
        why: null,
      },
      {
        kind: 'manual',
        do: 'Approve the payment in the finance system',
        area: null,
        when: 'inline',
        script: null,
        scriptSweptAt: null,
        actor: 'human',
        why: 'a manual step is a person’s by definition — it is the thing the fleet cannot do.',
      },
      {
        kind: 'state',
        do: 'Read the order row back',
        area: null,
        when: 'inline',
        script: null,
        scriptSweptAt: null,
        actor: 'fleet',
        why: null,
      },
    ],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'fleet',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    area: null,
    capture: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const briefing = checkBriefing(check);
  assert.match(briefing, /### The test plan/);
  assert.match(briefing, /\*\*Stop after step 1\.\*\*/, 'the boundary is drawn, not left for the agent to infer');
  assert.match(briefing, /Hand the check back with what you have/);
  assert.doesNotMatch(
    checkBriefing({ ...check, steps: [] }),
    /### The test plan/,
    'a check with no steps is the prose check it always was',
  );
  system.store.close();
});

test('a check whose first step is a person’s is never dispatched — it would hold a slot and block nothing', async () => {
  const person = {
    kind: 'manual' as const,
    do: 'Log in with the finance account',
    area: null,
    when: 'inline' as const,
    script: null,
    scriptSweptAt: null,
    actor: 'human' as const,
    why: 'a manual step is a person’s by definition — it is the thing the fleet cannot do.',
  };
  const fleet = { ...person, kind: 'state' as const, actor: 'fleet' as const, why: null };

  assert.equal(fleetCanStart([person, fleet]), false);
  assert.equal(fleetCanStart([fleet, person]), true, 'it runs as far as the boundary, which is worth dispatching');
  assert.equal(fleetCanStart([]), null, 'no steps is `fleetCandidate` and an operator’s press, exactly as before');

  const dispatched = async (steps: ValidationCheck['steps']): Promise<string[]> => {
    const decided = await new RuleDispatcher().decide(ctx(steps));
    return decided.actions
      .filter((a) => a.type === 'dispatch_code_agent')
      .map((a) => (a as { originRef?: string | null }).originRef ?? '');
  };

  assert.deepEqual(
    await dispatched([fleet, person]),
    ['issue:12:validate:an-order-places'],
    'a plan the fleet can start is dispatched, and it stops at the boundary',
  );
  assert.deepEqual(
    await dispatched([person, fleet]),
    [],
    'and one it cannot is left where an operator can see it, rather than becoming an agent sitting in ' +
      'front of somebody’s day',
  );
});

// ----------------------------------------------------- steps are read where they sit

test('a check’s state step is not a sheet row — it is read where it sits, not at assembly', () => {
  const rows = sheetRows({
    environment: FULL,
    checks: [
      fleetCheck([
        {
          kind: 'state',
          do: 'Read the order row back',
          area: null,
          when: 'inline',
          script: null,
          scriptSweptAt: null,
          actor: 'fleet',
          why: null,
        },
      ]),
    ],
    watches: [],
    queries: [],
    approvals: new Set(),
  });
  assert.deepEqual(
    rows.map((r) => r.rowId),
    ['check:an-order-places'],
    'a state reading taken at assembly asks a different question from the same reading taken after the ' +
      'browser steps — which is the whole reason steps exist',
  );
  assert.equal(rows[0]?.run, null, 'the check is the row; its steps are the journey inside it');
});

// --------------------------------------------------------------- persistence

test('a database from before the column reads as no steps, and nothing is backfilled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vsteps-db-'));
  const file = join(dir, 'harness.sqlite');
  let store = new Store(file);
  try {
    const parsed = validatePlanDocument({
      version: 1,
      reason: 'One fix.',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
      validation: { checks: [{ ...CHECK }] },
    });
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    ingestPlanDocument(store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });
    store.close();

    // What every row written before the column looks like: the column there, and nothing in it.
    const db = new Database(file);
    db.prepare(`UPDATE validation_checks SET steps=NULL`).run();
    db.close();

    store = new Store(file);
    assert.deepEqual(
      store.validation.listValidationChecks(GOAL)[0]?.steps,
      [],
      'null is "no steps", which stays true forever',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the column is declared as an additive migration, because the table already existed', () => {
  assert.equal(
    VALIDATION_COLUMNS.validation_checks?.steps,
    'TEXT',
    'CREATE TABLE IF NOT EXISTS never alters an existing table, so a column without an entry here is ' +
      'invisible on every database from before it',
  );
});
