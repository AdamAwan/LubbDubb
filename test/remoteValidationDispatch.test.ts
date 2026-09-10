import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_PIPELINE, DISPATCH_RULES } from '../src/dispatcher/rules.js';
import { PromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { remoteRunBriefs } from '../src/remoteValidation/briefing.js';
import { remoteValidationOriginParts } from '../src/remoteValidation/origin.js';
import { issueOriginRole } from '../src/issueOrigins.js';
import { MCP_TOOL_NAMES, DESKTOP_TOOL_NAMES, RETIRED_TOOL_NAMES, TOOL_NAMING } from '../src/mcp/names.js';
import { MCP_PROTOCOL_ADDENDUM } from '../src/agents/agentProtocol.js';
import { buildTools } from '../src/mcp/tools.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Agent, Issue, IssueDelivery, RemoteRunBrief, ValidationCheckInput } from '../src/types.js';

/*
 * The dispatch, the origin, the prompt and the report tool.
 * → docs/spec/36-remote-validation.md#the-dispatch--rule-remote-validation
 *
 * Every test that builds a system here injects `FakeRemoteRunner`, `FakeStateReader`,
 * `FakeTenantKeeper`, `FakeEnvironmentProber` and `FakeWorktreeManager`: the defaults are the
 * command implementations and the real worktree manager, so a test that configures a
 * `validate.browser` block and injects none of them drives a browser against somebody's acceptance
 * environment out of a lease cut in your own checkout — and passes while doing it.
 */

const NOW = '2026-09-08T12:00:00.000Z';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const RUN = 'run-9f2c';
const AREA = 'checkout with a saved card';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: {
    permits: ['check'],
    tenant: 'validation-customer-1',
    browser: {
      runner: 'npm run e2e -- --project=validation',
      listSelectors: 'npm run e2e -- --project=validation --list',
      profile: 'acc-uk',
      publishArtefacts: './scripts/publish-report.sh',
    },
  },
};

const OFF: EnvironmentConfig = { name: 'acceptance', at: './scripts/deployed-sha.sh acceptance' };

const CHECK: ValidationCheckInput = {
  id: 'an-order-places',
  seq: 1,
  title: 'An order still places end to end',
  do: 'Place one',
  expect: 'It places',
  uses: [],
  covers: [],
  fleetCandidate: false,
  candidateWhy: null,
};

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship the channel',
    body: 'orders should carry a channel',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'PR #40 landed it',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * How an author *declares* an area is not built — the column is, and null means no area declared. A
 * test writes one the way whatever declares it later will: onto the column, on a check that exists.
 */
function setArea(file: string, area: string): void {
  const db = new Database(file);
  try {
    db.prepare(`UPDATE validation_checks SET area=? WHERE origin_ref=? AND id=?`).run(area, 'issue:12', CHECK.id);
  } finally {
    db.close();
  }
}

/** A goal delivered, landed and sheeted with one `check` row the pre-flight matched. */
function seedSheet(store: Store, environment = 'acceptance'): void {
  store.ingestValidation('issue:12', { checks: [CHECK], resources: [], supersededReason: '', amendNote: '' });
  store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.openRemoteSheet({ goalRef: 'issue:12', environment });
  store.saveRemoteSheetRows('issue:12', environment, [
    {
      rowId: `check:${CHECK.id}`,
      kind: 'check',
      seq: 1,
      title: CHECK.title,
      sourceId: CHECK.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: 4,
    },
  ]);
}

/** The same, with the check's area declared — which is what makes its row a runner's rather than a person's. */
function seed(b: Pick<Bench, 'store' | 'file'>, environment = 'acceptance'): void {
  seedSheet(b.store, environment);
  setArea(b.file, AREA);
}

function press(store: Store, environment = 'acceptance'): string {
  const { run } = store.beginRemoteRun({
    goalRef: 'issue:12',
    environment,
    tenant: 'validation-customer-1',
    startedSha: DEPLOYED,
  });
  assert.ok(run, 'the press opened a run');
  return run.id;
}

function briefs(store: Store, environments: EnvironmentConfig[] = [ACCEPTANCE]): RemoteRunBrief[] {
  return remoteRunBriefs({ store, environments, validationRoot: '/srv/validation' });
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    deliveries: [delivered()],
    ...over,
  };
}

function dispatcher(on = true, templates?: PromptTemplates): RuleDispatcher {
  return new RuleDispatcher(
    {},
    {},
    templates,
    'main',
    {},
    {},
    {},
    '/srv/validation',
    '#',
    {},
    undefined,
    '',
    '',
    undefined,
    '',
    '',
    on,
  );
}

interface Bench {
  store: Store;
  file: string;
  close(): void;
}

/** File-backed, because the area is written onto the column the way whatever declares it later will. */
function bench(): Bench {
  const file = join(mkdtempSync(join(tmpdir(), 'lubbdubb-remote-dispatch-')), 'harness.db');
  const store = new Store(file);
  return { store, file, close: () => store.close() };
}

/* ── the rule ────────────────────────────────────────────────────────────────────────────────── */

test('the position in DISPATCH_PIPELINE is below validate-check and above validation-failed', () => {
  const at = (id: string): number => DISPATCH_PIPELINE.findIndex((r) => r.id === id);
  const me = at('remote-validation');
  assert.notEqual(me, -1, 'it takes a position — a rule declared and never walked produces nothing');
  assert.equal(
    DISPATCH_PIPELINE[me - 1]?.id,
    'validate-check',
    'below the handed-over check, which is the older obligation an operator explicitly assigned',
  );
  assert.equal(
    DISPATCH_PIPELINE[me + 1]?.id,
    'validation-failed',
    'above the diagnosis, because this rule produces that rule’s input',
  );
});

test('an open run dispatches one code agent, read-only and pinned to the deployed commit', async () => {
  const b = bench();
  try {
    seed(b);
    const runId = press(b.store);
    const { actions, upcoming } = await dispatcher().decide(ctx({ remoteRuns: briefs(b.store) }));

    const dispatch = actions.find((a) => a.type === 'dispatch_code_agent' && a.rule === 'remote-validation');
    assert.ok(dispatch?.type === 'dispatch_code_agent');
    assert.ok(dispatch, 'one code agent, on the run row');
    assert.equal(dispatch.originRef, `issue:12:validate-remote:${runId}`);
    assert.equal(dispatch.branch, `validate-remote/issue/12/${runId}`, 'the name is a lease key');
    assert.equal(dispatch.base, DEPLOYED, 'pinned to the deployed commit, never to a branch');
    assert.equal(dispatch.readOnly, true, 'and no ref is minted');
    assert.equal(
      upcoming?.find((q) => q.origin === dispatch.originRef)?.status,
      'dispatching',
      'it routes through the candidate list rather than an inline raw.push',
    );
  } finally {
    b.close();
  }
});

test('a capped run queues as waiting rather than vanishing', async () => {
  const b = bench();
  try {
    seed(b);
    const runId = press(b.store);
    const { actions, upcoming } = await dispatcher().decide(ctx({ remoteRuns: briefs(b.store), agentHeadroom: 0 }));

    assert.equal(
      actions.some((a) => a.type === 'dispatch_code_agent'),
      false,
      'the headroom cut applies to it like any other candidate',
    );
    const queued = upcoming?.find((q) => q.origin === `issue:12:validate-remote:${runId}`);
    assert.equal(queued?.status, 'waiting', 'and it is on the Up next queue rather than gone');
    assert.equal(queued?.rule, 'remote-validation');
  } finally {
    b.close();
  }
});

test('a sheet nobody pressed dispatches nothing — the rule reads run rows, never sheets', async () => {
  const b = bench();
  try {
    seed(b);
    assert.deepEqual(briefs(b.store), [], 'no run row, so nothing to brief');
    const { actions } = await dispatcher().decide(ctx({ remoteRuns: briefs(b.store) }));
    assert.equal(
      actions.some((a) => a.type === 'dispatch_code_agent'),
      false,
    );
  } finally {
    b.close();
  }
});

test('the rule book draws it inert where no environment declares a validate block', async () => {
  const b = bench();
  try {
    seed(b);
    press(b.store);
    assert.deepEqual(briefs(b.store, [OFF]), [], 'an environment with no browser block briefs nothing');

    const { actions, upcoming } = await dispatcher(false).decide(ctx({ remoteRuns: briefs(b.store) }));
    assert.equal(
      actions.some((a) => a.rule === 'remote-validation'),
      false,
      'the enabled predicate holds the whole stage, not just its output',
    );
    assert.equal(
      upcoming?.some((q) => q.rule === 'remote-validation'),
      false,
    );
    assert.equal(
      typeof DISPATCH_PIPELINE.find((r) => r.id === 'remote-validation')?.enabled,
      'function',
      'it carries an enabled predicate, so the book draws it inert rather than live-and-never-firing',
    );
  } finally {
    b.close();
  }
});

test('one agent per run: the dispatched flip is the store’s conditional update, across a restart', () => {
  const first = bench();
  let runId: string;
  try {
    seed(first);
    runId = press(first.store);
    assert.equal(briefs(first.store).length, 1, 'the open run is proposed');
    assert.ok(first.store.claimRemoteRun(runId, 'task-1'), 'the first dispatch claims it');
    assert.equal(first.store.claimRemoteRun(runId, 'task-2'), null, 'and a second changes no row');
    assert.equal(first.store.getRemoteRun(runId)?.taskId, 'task-1');
  } finally {
    first.close();
  }

  const restarted = new Store(first.file);
  try {
    const run = restarted.getRemoteRun(runId);
    assert.equal(run?.status, 'dispatched', 'the claim is a column value and survives the restart');
    assert.equal(run?.taskId, 'task-1');
    assert.deepEqual(
      briefs(restarted).map((brief) => brief.status),
      ['dispatched'],
      'the run is still live, so the lock still holds over it',
    );
    assert.equal(restarted.claimRemoteRun(runId, 'task-3'), null, 'and no second agent is ever proposed for it');
  } finally {
    restarted.close();
  }
});

test('the rule proposes nothing for a run something already claimed', async () => {
  const b = bench();
  try {
    seed(b);
    const runId = press(b.store);
    b.store.claimRemoteRun(runId, 'task-1');
    const { actions } = await dispatcher().decide(ctx({ remoteRuns: briefs(b.store) }));
    assert.equal(
      actions.some((a) => a.rule === 'remote-validation'),
      false,
    );
  } finally {
    b.close();
  }
});

test('no cooldown budget and no escalation: it is re-proposed each pulse until it dispatches', async () => {
  const b = bench();
  try {
    seed(b);
    const runId = press(b.store);
    const origin = `issue:12:validate-remote:${runId}`;
    const attempts = Array.from({ length: 6 }, (_unused, at) => ({
      id: `d${String(at)}`,
      cycleId: 'c1',
      rule: 'remote-validation',
      admission: null,
      reason: 'ran it',
      outcome: 'executed',
      detail: null,
      action: { type: 'dispatch_code_agent', title: 't', prompt: 'p', branch: 'b', originRef: origin },
      createdAt: NOW,
    })) as unknown as DispatchContext['recentDecisions'];

    const { actions } = await dispatcher().decide(ctx({ remoteRuns: briefs(b.store), recentDecisions: attempts }));
    assert.equal(
      actions.some((a) => a.rule === 'remote-validation' && a.type === 'dispatch_code_agent'),
      true,
      'a run row is one press rather than a standing signal',
    );
    assert.equal(
      actions.some((a) => a.type === 'escalate_to_human' && a.rule === 'remote-validation'),
      false,
      'and there is nothing to escalate about — the operator pressed it themselves',
    );
  } finally {
    b.close();
  }
});

/* ── the origin ──────────────────────────────────────────────────────────────────────────────── */

test('validate-remote: is evidence in src/issueOrigins.ts, and never unrecognised', () => {
  const role = issueOriginRole(12, `issue:12:validate-remote:${RUN}`);
  assert.equal(role, 'evidence', 'a run is evidence about delivered work, not work');
  assert.notEqual(role, 'unrecognised', 'left out it stops expanding under a priority flag and files under "other"');
});

test('the origin fence is the narrow kind', () => {
  assert.deepEqual(remoteValidationOriginParts(`issue:12:validate-remote:${RUN}`), { issueNumber: 12, runId: RUN });
  for (const other of [
    'issue:12',
    'issue:12:part:schema',
    'issue:12:plan',
    'issue:12:assess',
    'issue:12:validate:an-order-places',
    'issue:12:validate-failure:an-order-places',
    'issue:12:validate-local:abc',
    null,
  ])
    assert.equal(
      remoteValidationOriginParts(other),
      null,
      `${other ?? '(none)'} is refused: which run a report concerns is settled before the report, never by it`,
    );
});

/* ── the prompt ──────────────────────────────────────────────────────────────────────────────── */

/** What the rule would send, with the briefing appended to whatever the template rendered. */
async function promptFor(store: Store, templates?: PromptTemplates): Promise<string> {
  const { actions } = await dispatcher(true, templates).decide(ctx({ remoteRuns: briefs(store) }));
  const dispatch = actions.find((a) => a.rule === 'remote-validation' && a.type === 'dispatch_code_agent');
  assert.ok(dispatch?.type === 'dispatch_code_agent', 'a dispatch was proposed');
  return dispatch.prompt;
}

test('everything the agent must read is appended, and an override that names no token still gets it', async () => {
  const b = bench();
  try {
    seed(b);
    const runId = press(b.store);
    const plain = await promptFor(b.store);
    const overridden = await promptFor(
      b.store,
      new PromptTemplates({ 'remote-validation': 'Go and run the sheet. Nothing else is stated here.' }),
    );

    for (const prompt of [plain, overridden]) {
      assert.match(prompt, /npm run e2e -- --project=validation/, 'the declared runner command');
      assert.match(prompt, /\.\/scripts\/publish-report\.sh/, 'and the publish command');
      assert.match(prompt, /acc-uk/, 'the profile alias the suite knows this place by');
      assert.match(prompt, /checkout with a saved card/, 'the selector the confirmed row is verified against');
      assert.match(prompt, /validation-customer-1/, 'the tenant');
      assert.match(prompt, new RegExp(DEPLOYED), 'the deployed commit');
      assert.match(prompt, new RegExp(`/srv/validation/issue-12/remote/${runId}/report`), 'the report directory');
      assert.match(prompt, new RegExp(`/srv/validation/issue-12/remote/${runId}/artefacts`), 'the artefact directory');
      assert.match(prompt, /LUBBDUBB_SELECTORS=/, 'the parameters ride in the environment, never in the command');
      assert.match(prompt, /remote_validation_report/, 'and the one way it may answer');
      assert.match(prompt, /handback/, 'including that a handback is a right answer');
      assert.match(prompt, /exit code decides nothing|exit code is never/i, 'and that the exit code decides nothing');
      assert.match(prompt, /read-only checkout/, 'and the rules of the run');
      assert.match(prompt, /Do not edit the suite/, 'not a selector, not a timeout, not a skip');
    }
    assert.equal(
      overridden.includes('Nothing else is stated here.'),
      true,
      'the override is what was rendered — and every token above still reached the agent, appended',
    );
  } finally {
    b.close();
  }
});

test('a tenantEnv’s value never reaches the prompt — the variable’s own name does', () => {
  const b = bench();
  try {
    seed(b, 'acceptance');
    press(b.store);
    const environments: EnvironmentConfig[] = [
      { ...ACCEPTANCE, validate: { ...ACCEPTANCE.validate!, tenant: undefined, tenantEnv: 'VALIDATION_TENANT' } },
    ];
    const brief = remoteRunBriefs({
      store: b.store,
      environments,
      validationRoot: '/srv/validation',
      env: { VALIDATION_TENANT: 'secret-customer-77' },
    })[0];
    assert.ok(brief);
    assert.match(brief.briefing, /VALIDATION_TENANT/, 'the prompt carries the variable’s own name');
    assert.equal(
      brief.briefing.includes('secret-customer-77'),
      false,
      'and never its value, which goes into the spawn env and nowhere else',
    );
  } finally {
    b.close();
  }
});

/* ── the report tool ─────────────────────────────────────────────────────────────────────────── */

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function system(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remote-report-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot: dir,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      environments: [ACCEPTANCE],
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      remoteRunner: new FakeRemoteRunner(),
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
}

function agentOn(sys: System, originRef: string, branch: string): Agent {
  const task = sys.store.createTask({
    kind: 'code',
    title: 'Run the sheet',
    prompt: 'run it',
    branch,
    originRef,
    originTitle: 'Ship the channel',
  });
  return sys.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

function schemaOf(sys: System, agent: Agent, name: string): Record<string, unknown> {
  const task = sys.store.getTask(agent.taskId)!;
  const tool = buildTools({ store: sys.store, agents: sys.agents }, { agent, task }).find((t) => t.name === name);
  assert.ok(tool, `${name} is built, so the name and the module agree`);
  return tool.inputSchema as Record<string, unknown>;
}

test('the advertised schema has no field an agent could state an outcome in', () => {
  const sys = system();
  try {
    seedSheet(sys.store);
    const runId = press(sys.store);
    const agent = agentOn(sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
    const schema = schemaOf(sys, agent, 'remote_validation_report');

    assert.deepEqual(
      Object.keys((schema['properties'] ?? {}) as Record<string, unknown>).sort(),
      ['artefacts', 'handback', 'reportPath'],
      'where the report landed, where the artefacts went, or why there is neither — and nothing else',
    );
    assert.equal(schema['additionalProperties'], false, 'and an extra key is rejected rather than ignored');
    assert.equal(MCP_TOOL_NAMES.includes('remote_validation_report'), true);
    assert.equal(TOOL_NAMING['remote_validation_report'], 'point-of-use');
  } finally {
    sys.store.close();
  }
});

test('it is named at the point of use only — not in the addendum, not on the desktop channel', () => {
  assert.equal(
    /\bremote_validation_report\b/.test(MCP_PROTOCOL_ADDENDUM),
    false,
    'an addendum entry would advertise it to every planner and part agent in the fleet',
  );
  assert.equal(
    (DESKTOP_TOOL_NAMES as readonly string[]).includes('remote_validation_report'),
    false,
    'the desktop credential is long-lived and there is no path from it to a fleet tool',
  );
  assert.equal((DESKTOP_TOOL_NAMES as readonly string[]).includes('state_declare'), false, 'and neither is that one');
});

test('a report records where things landed and settles the run, readably afterwards', async () => {
  const sys = system();
  try {
    seedSheet(sys.store);
    const runId = press(sys.store);
    const agent = agentOn(sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
    const result = (await sys.mcp.session(agent.id)!.call('remote_validation_report', {
      reportPath: `/srv/validation/issue-12/remote/${runId}/report/results.json`,
      artefacts: 'https://reports.example.com/run/9f2c',
    })) as ToolResultText;
    assert.equal(result.isError, undefined);

    const run = sys.store.getRemoteRun(runId);
    assert.equal(run?.status, 'ended');
    assert.equal(run?.reportPath, `/srv/validation/issue-12/remote/${runId}/report/results.json`);
    assert.equal(run?.artefacts, 'https://reports.example.com/run/9f2c');
    assert.deepEqual(
      sys.store.listRemoteReadings(),
      [],
      'this check declares no area, so it was never a runner’s question and the fold has no row to read',
    );

    const again = (await sys.mcp.session(agent.id)!.call('remote_validation_report', {
      reportPath: '/somewhere/else.json',
    })) as ToolResultText;
    assert.equal(again.isError, true, 'a settled run is settled');
    assert.match(again.content[0]?.text ?? '', /already settled as ended/);
  } finally {
    sys.store.close();
  }
});

test('a handback settles the run with the reason, writes no readings and leaves every row as it was', async () => {
  const sys = system();
  try {
    seedSheet(sys.store);
    const runId = press(sys.store);
    const before = sys.store.listRemoteSheetRows();
    const agent = agentOn(sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
    const result = (await sys.mcp.session(agent.id)!.call('remote_validation_report', {
      handback: 'the acceptance environment refused every login, so nothing was driven',
    })) as ToolResultText;
    assert.equal(result.isError, undefined);

    const run = sys.store.getRemoteRun(runId);
    assert.equal(run?.status, 'abandoned');
    assert.match(run?.note ?? '', /refused every login/, 'the agent’s reason reaches the operator');
    assert.deepEqual(sys.store.listRemoteReadings(), [], 'a handback writes no readings');
    assert.deepEqual(sys.store.listRemoteSheetRows(), before, 'and leaves every row exactly as it was');
    assert.equal(
      sys.store.listValidationChecks('issue:12').find((c) => c.id === CHECK.id)?.state,
      'unrun',
      'an agent that could not reach the environment has learned nothing about the goal',
    );
  } finally {
    sys.store.close();
  }
});

test('every other caller is refused by name, and this run’s own agent is refused validation_report', async () => {
  const sys = system();
  try {
    seedSheet(sys.store);
    const runId = press(sys.store);

    for (const [origin, branch] of [
      ['issue:12', 'issue/12'],
      ['issue:12:part:schema', 'issue/12/schema'],
      ['issue:12:validate-failure:an-order-places', 'validate-failure/issue/12/an-order-places'],
    ] as const) {
      const other = agentOn(sys, origin, branch);
      const refused = (await sys.mcp
        .session(other.id)!
        .call('remote_validation_report', { reportPath: '/tmp/results.json' })) as ToolResultText;
      assert.equal(refused.isError, true, `${origin} is refused`);
      assert.match(refused.content[0]?.text ?? '', /issue:<n>:validate-remote:<runId>/);
    }
    assert.equal(sys.store.getRemoteRun(runId)?.status, 'pending', 'and none of them settled the run');

    const mine = agentOn(sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
    const crossed = (await sys.mcp
      .session(mine.id)!
      .call('validation_report', { result: 'passed', note: 'it looked fine' })) as ToolResultText;
    assert.equal(crossed.isError, true, 'this run’s agent may not record a reading on a check either');
  } finally {
    sys.store.close();
  }
});

test('a withdrawn tool name is answered from RETIRED_TOOL_NAMES rather than as an unknown method', async () => {
  const sys = system();
  try {
    seedSheet(sys.store);
    const agent = agentOn(sys, 'issue:12', 'issue/12');
    const retired = RETIRED_TOOL_NAMES[0];
    assert.ok(retired, 'the mechanism exists and is what a withdrawn name goes into');
    const answered = (await sys.mcp.session(agent.id)!.call(retired, {})) as ToolResultText;
    assert.equal(answered.isError, true);
    assert.match(answered.content[0]?.text ?? '', /has been retired/, 'a refusal that points at what replaced it');

    const unknown = await sys.mcp.session(agent.id)!.call('remote_validation_reporrt', {});
    assert.notDeepEqual(unknown, answered, 'which is a different thing from a name that is simply gone');
    assert.equal(
      MCP_TOOL_NAMES.includes('remote_validation_report'),
      true,
      'so neither name shipped here is ever deleted — it is retired instead',
    );
    assert.equal(DISPATCH_RULES['remote-validation'].kind, 'rule');
  } finally {
    sys.store.close();
  }
});
