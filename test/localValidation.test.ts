import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { localValidationFileSignerFor } from '../src/server/routes/artifacts.js';
import { verifyArtifactCapability } from '../src/server/artifactCapability.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { DEFAULT_LOCAL_VALIDATION, substituteBrowserArgs } from '../src/localValidation/policy.js';
import { validationRunStale } from '../src/localValidation/stale.js';
import { validateLocalValidationReport } from '../src/localValidation/report.js';
import { localValidationOriginParts, localValidationFixOriginParts } from '../src/localValidation/origin.js';
import { issueOriginRole } from '../src/issueOrigins.js';
import { buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { ALLOWED_MCP_TOOLS, extraMcpGrants, MCP_SERVER_ID } from '../src/mcp/names.js';
import type { Agent, Issue, LocalRun, LocalValidation } from '../src/types.js';
import { repoText } from './support/paths.js';

const NOW = '2025-01-01T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const LATER_COMMIT = 'b'.repeat(40);

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lv-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      localRunRoot: join(dir, 'local-run'),
      validationRoot: join(dir, 'validation'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      localRun: { instruction: 'npm run dev', url: 'http://localhost:5173' } as never,
      ...overrides,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function liveRun(system: System, originRef = 'issue:12', ref = 'issue/12', commit = COMMIT): LocalRun {
  const run = system.store.localRuns.beginLocalRun({
    originRef,
    ref,
    dir: '/tmp/local-run',
    commit,
    url: 'http://localhost:5173',
  });
  system.store.localRuns.setLocalRunStatus(run.id, 'running');
  return system.store.localRuns.liveLocalRun() as LocalRun;
}

function request(system: System, originRef = 'issue:12'): LocalValidation {
  const run = system.store.localRuns.liveLocalRun();
  assert.ok(run, 'a run is up to pin the validation to');
  return system.localValidations.request({ originRef, run });
}

function spawnAgent(system: System, originRef: string, branch = 'issue/12'): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch,
    originRef,
    originTitle: 'Ship it',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session.call(name, args)) as ToolResultText;
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

function row(over: Partial<LocalValidation> = {}): LocalValidation {
  return {
    id: 'lv1',
    originRef: 'issue:12',
    runId: 'run-1',
    ref: 'issue/12',
    commit: COMMIT,
    status: 'pending',
    requestedAt: NOW,
    dispatchedAt: null,
    endedAt: null,
    taskId: null,
    fixTaskId: null,
    plan: null,
    summary: null,
    findings: [],
    visited: [],
    screenshots: [],
    note: null,
    ...over,
  };
}

function run(over: Partial<LocalRun> = {}): LocalRun {
  return {
    id: 'run-1',
    originRef: 'issue:12',
    ref: 'issue/12',
    dir: '/tmp/local-run',
    commit: COMMIT,
    pid: 1,
    status: 'running',
    url: 'http://localhost:5173',
    note: null,
    startedAt: NOW,
    endedAt: null,
    interruptedAt: null,
    lastSeenAt: NOW,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    ...over,
  };
}

test('the pin holds only while the same environment is up, and says which way it broke', () => {
  assert.equal(validationRunStale(row(), run()), null, 'the run it was planned against');

  assert.match(validationRunStale(row(), null) ?? '', /stopped/);
  assert.match(validationRunStale(row(), run({ id: 'run-2' })) ?? '', /restarted/);
  assert.match(validationRunStale(row(), run({ id: 'run-2', originRef: 'issue:99' })) ?? '', /swapped to issue:99/);
  assert.match(validationRunStale(row(), run({ status: 'stopping' })) ?? '', /taken down/);
  assert.match(validationRunStale(row(), run({ commit: LATER_COMMIT })) ?? '', /refreshed onto bbbbbbb/);
  assert.match(validationRunStale(row({ commit: null }), run()) ?? '', /never recorded/);
});

test('a failure with nothing found is refused, and pointed at the answer that fits', () => {
  const good = validateLocalValidationReport({
    result: 'failed',
    summary: 'the form takes an empty schema',
    findings: [{ title: 'empty schema accepted', detail: 'posted it, got a 201', severity: 'blocker' }],
  });
  assert.ok(good.ok);

  const empty = validateLocalValidationReport({ result: 'failed', summary: 'something was wrong' });
  assert.ok(!empty.ok);
  assert.match(empty.error, /blocked/);

  const blocked = validateLocalValidationReport({ result: 'blocked', summary: 'it never came up' });
  assert.ok(blocked.ok, 'blocked needs no findings — that is what it is for');

  const pathy = validateLocalValidationReport({
    result: 'failed',
    summary: 's',
    findings: [{ title: 't', detail: 'd', severity: 'nit', screenshot: '../etc/passwd' }],
  });
  assert.ok(!pathy.ok, 'a screenshot is a file name, not a path');
});

test('the two origins are told apart, and only the validation may report', () => {
  assert.deepEqual(localValidationOriginParts('issue:12:validate-local:lv1'), { issueNumber: 12, id: 'lv1' });
  assert.equal(localValidationOriginParts('issue:12:validate-local-fix:lv1'), null);
  assert.deepEqual(localValidationFixOriginParts('issue:12:validate-local-fix:lv1'), { issueNumber: 12, id: 'lv1' });
  assert.equal(localValidationFixOriginParts('issue:12:validate-local:lv1'), null);

  assert.equal(issueOriginRole(12, 'issue:12:validate-local:lv1'), 'evidence');
  assert.equal(issueOriginRole(12, 'issue:12:validate-local-fix:lv1'), 'work');
});

test('the browser server is given this validation’s own directories', () => {
  const filled = substituteBrowserArgs(DEFAULT_LOCAL_VALIDATION.browser as never, {
    outputDir: '/srv/validation/issue-12/local/lv1',
    profileDir: '/srv/validation/.browser-profile',
  });
  assert.ok(filled.args.includes('/srv/validation/issue-12/local/lv1'));
  assert.ok(filled.args.includes('/srv/validation/.browser-profile'));
  assert.ok(!filled.args.some((a) => a.includes('{')), 'no token is left standing');
});

test('an extra server rides the harness’s own launch, and its grant is added rather than substituted', () => {
  const servers = [{ key: 'browser', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }];
  const args = buildClaudeStreamArgs({
    mcpConfigPath: '/tmp/launch.json',
    extraAllowedTools: extraMcpGrants(servers),
  });
  const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
  assert.ok(allowed.startsWith(ALLOWED_MCP_TOOLS.join(',')), 'the fleet’s grants are intact');
  assert.ok(allowed.endsWith('mcp__browser'));
  assert.equal(args.filter((a) => a === '--mcp-config').length, 1, 'one document, one file');
  assert.ok(!args.includes('--strict-mcp-config'), 'the target repo’s own servers are never suppressed');
});

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
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
    localRun: run(),
    localValidations: [row()],
    ...over,
  };
}

function rules(policy = DEFAULT_LOCAL_VALIDATION): RuleDispatcher {
  return new RuleDispatcher({
    defaultBranch: 'main',
    validationRoot: '/srv/validation',
    prRefStyle: '#',
    reviewCharters: { routing: null, modes: {} },
    watchNote: '',
    watchDeclareNote: '',
    localValidation: () => policy,
  });
}

function dispatchesOn(actions: { type: string }[], marker: string): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.includes(marker));
}

test('it fires while the environment is still coming up, which is the point of the timing', async () => {
  const starting = await rules().decide(ctx({ localRun: run({ status: 'starting' }) }));
  assert.deepEqual(dispatchesOn(starting.actions, ':validate-local:'), ['issue:12:validate-local:lv1']);

  const running = await rules().decide(ctx());
  assert.deepEqual(dispatchesOn(running.actions, ':validate-local:'), ['issue:12:validate-local:lv1']);
});

test('nothing is dispatched against an environment that is no longer the one that was asked about', async () => {
  for (const live of [null, run({ status: 'stopping' }), run({ id: 'run-2' }), run({ commit: LATER_COMMIT })]) {
    const plan = await rules().decide(ctx({ localRun: live }));
    assert.deepEqual(dispatchesOn(plan.actions, ':validate-local:'), [], 'the pin no longer holds');
  }
});

test('one agent per press: a row already dispatched proposes nothing', async () => {
  const dispatched = await rules().decide(ctx({ localValidations: [row({ status: 'dispatched', taskId: 't1' })] }));
  assert.deepEqual(dispatchesOn(dispatched.actions, ':validate-local:'), []);
});

test('the checkout is read-only and pinned to the commit the environment stands at', async () => {
  const plan = await rules().decide(ctx());
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-local:lv1');
  assert.equal(action?.type, 'dispatch_code_agent');
  const dispatch = action as unknown as {
    branch: string;
    base: string;
    readOnly: boolean;
    prompt: string;
    mcpServers: { key: string; args: string[] }[];
  };
  assert.equal(dispatch.branch, 'validate-local/issue/12/lv1');
  assert.equal(dispatch.readOnly, true);
  assert.equal(dispatch.base, COMMIT);
  assert.equal(dispatch.mcpServers[0]?.key, 'browser');
  assert.ok(dispatch.mcpServers[0]?.args.some((a) => a.includes(join('issue-12', 'local', 'lv1'))));
});

test('what the agent cannot act without is appended, never interpolated', async () => {
  const plan = await rules({
    ...DEFAULT_LOCAL_VALIDATION,
    instruction: 'Sign in as dev@example.com, no password.',
  } as never).decide(ctx());
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-local:lv1');
  const prompt = (action as unknown as { prompt: string }).prompt;
  assert.match(prompt, /Sign in as dev@example\.com/);
  assert.match(prompt, /http:\/\/localhost:5173/);
  assert.match(prompt, /local_validation_plan/);
  assert.match(prompt, /local_run_read/);
  assert.match(prompt, /local_validation_report/);
  assert.match(prompt, /is not evidence/);
});

test('a configured browser is offered as a claim to check, not as a fact', async () => {
  const plan = await rules().decide(ctx());
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-local:lv1');
  const prompt = (action as unknown as { prompt: string }).prompt;

  assert.match(prompt, /\*\*should\*\* have one/);
  assert.match(prompt, /Check that before you plan around it/);
  assert.match(prompt, /not a finding about this goal/);
  assert.match(prompt, /Do not report `failed`/);
});

test('with no browser configured the prompt says so rather than leaving the agent to find out', async () => {
  const plan = await rules({ instruction: '', browser: null }).decide(ctx());
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-local:lv1');
  const dispatch = action as unknown as { prompt: string; mcpServers: unknown[] };
  assert.deepEqual(dispatch.mcpServers, []);
  assert.match(dispatch.prompt, /There is no browser/);
  assert.match(dispatch.prompt, /report `blocked`/);
});

const FAILED = row({
  status: 'failed',
  endedAt: NOW,
  summary: 'the form takes an empty schema',
  findings: [
    {
      title: 'empty schema accepted',
      detail: 'posted it, got a 201',
      severity: 'blocker',
      url: null,
      screenshot: null,
    },
  ],
});

test('a failed reading puts one writable agent on the branch that was validated', async () => {
  const plan = await rules().decide(ctx({ localValidations: [FAILED] }));
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-local-fix:lv1');
  assert.equal(action?.type, 'dispatch_code_agent');
  const dispatch = action as unknown as { branch: string; readOnly: boolean; prompt: string };
  assert.equal(dispatch.branch, 'issue/12', 'on the branch whose behaviour was wrong');
  assert.equal(dispatch.readOnly, false, 'this one writes');
  assert.match(dispatch.prompt, /empty schema accepted/);
  assert.match(dispatch.prompt, /Do not open a pull request/);
});

test('one fix per reading, and none at all where there is no branch to put it on', async () => {
  const latched = await rules().decide(ctx({ localValidations: [{ ...FAILED, fixTaskId: 't9' }] }));
  assert.deepEqual(dispatchesOn(latched.actions, ':validate-local-fix:'), [], 'the latch holds');

  const blocked = await rules().decide(ctx({ localValidations: [{ ...FAILED, status: 'blocked', findings: [] }] }));
  assert.deepEqual(dispatchesOn(blocked.actions, ':validate-local-fix:'), [], 'blocked found nothing to fix');

  const onMain = await rules().decide(ctx({ localValidations: [{ ...FAILED, ref: 'main' }] }));
  assert.deepEqual(dispatchesOn(onMain.actions, ':validate-local-fix:'), []);
});

test('a report against the run it was planned against is recorded; one against a moved environment is not', async () => {
  const system = build();
  liveRun(system);
  const validation = request(system);
  system.store.localValidations.markLocalValidationDispatched(validation.id, 'task-x');
  const agent = spawnAgent(system, `issue:12:validate-local:${validation.id}`);

  const planned = await callTool(system, agent, 'local_validation_plan', { plan: '## Plan\n1. Open it.' });
  assert.ok(!planned.isError, planned.text);
  assert.equal(system.store.localValidations.getLocalValidation(validation.id)?.plan, '## Plan\n1. Open it.');

  const live = system.store.localRuns.liveLocalRun();
  assert.ok(live);
  system.store.localRuns.setLocalRunCommit(live.id, LATER_COMMIT);

  const refused = await callTool(system, agent, 'local_validation_report', {
    result: 'passed',
    summary: 'it all worked',
  });
  assert.ok(refused.isError, 'a reading of a checkout nobody asked about is not recorded');
  assert.match(refused.text, /refreshed onto/);
  assert.match(refused.text, /blocked/);
  assert.equal(
    system.store.localValidations.getLocalValidation(validation.id)?.status,
    'dispatched',
    'nothing was written',
  );

  const blocked = await callTool(system, agent, 'local_validation_report', {
    result: 'blocked',
    summary: 'the checkout moved while I was working',
  });
  assert.ok(!blocked.isError, blocked.text);
  assert.equal(system.store.localValidations.getLocalValidation(validation.id)?.status, 'blocked');
  system.store.close();
});

test('a failed reading writes the row and nothing else — never a shortfall', async () => {
  const system = build();
  liveRun(system);
  const validation = request(system);
  system.store.localValidations.markLocalValidationDispatched(validation.id, 'task-x');
  const agent = spawnAgent(system, `issue:12:validate-local:${validation.id}`);

  const reported = await callTool(system, agent, 'local_validation_report', {
    result: 'failed',
    summary: 'the form takes an empty schema',
    findings: [{ title: 'empty schema accepted', detail: 'posted it, got a 201', severity: 'blocker' }],
    visited: ['http://localhost:5173/jobs/new'],
  });
  assert.ok(!reported.isError, reported.text);

  const settled = system.store.localValidations.getLocalValidation(validation.id);
  assert.equal(settled?.status, 'failed');
  assert.equal(settled?.findings.length, 1);
  assert.deepEqual(settled?.visited, ['http://localhost:5173/jobs/new']);
  assert.equal(system.store.verdicts.getShortfall('issue:12'), null);
  assert.equal(system.store.verdicts.getDelivery('issue:12'), null);
  system.store.close();
});

test('every other agent is refused by name, and told which tool it wanted', async () => {
  const system = build();
  liveRun(system);
  request(system);
  const agent = spawnAgent(system, 'issue:12:part:the-change');

  for (const tool of ['local_validation_plan', 'local_validation_report', 'local_run_read']) {
    const args =
      tool === 'local_validation_plan'
        ? { plan: 'x' }
        : tool === 'local_run_read'
          ? {}
          : { result: 'passed', summary: 's' };
    const refused = await callTool(system, agent, tool, args);
    assert.ok(refused.isError, `${tool} is fenced to the dispatch it belongs to`);
    assert.match(refused.text, /were not dispatched for one/);
  }
  system.store.close();
});

test('local_run_read reports the environment and carries the caution with it', async () => {
  const system = build();
  liveRun(system);
  const validation = request(system);
  const agent = spawnAgent(system, `issue:12:validate-local:${validation.id}`);
  const read = await callTool(system, agent, 'local_run_read', {});
  assert.ok(!read.isError, read.text);
  const body = read.json();
  assert.equal(body.running, true);
  assert.equal(body.url, 'http://localhost:5173');
  assert.match(String(body.caveat), /does not exercise the application/);
  system.store.close();
});

test('the desk settles what nobody will answer: a stopped environment, and a dead agent', async () => {
  const stopped = build();
  const first = liveRun(stopped);
  const swept = request(stopped);
  stopped.store.localRuns.setLocalRunStatus(first.id, 'stopped');
  stopped.localValidations.sweep();
  const gone = stopped.store.localValidations.getLocalValidation(swept.id);
  assert.equal(gone?.status, 'abandoned');
  assert.match(gone?.note ?? '', /stopped/);
  stopped.store.close();

  const dead = build();
  liveRun(dead);
  const orphan = request(dead);
  const task = dead.store.tasks.createTask({
    kind: 'code',
    title: 't',
    prompt: 'p',
    branch: null,
    originRef: 'issue:12',
  });
  dead.store.localValidations.markLocalValidationDispatched(orphan.id, task.id);
  dead.store.tasks.updateTask(task.id, { status: 'failed' });
  dead.localValidations.sweep();
  const settled = dead.store.localValidations.getLocalValidation(orphan.id);
  assert.equal(settled?.status, 'abandoned');
  assert.match(settled?.note ?? '', /without reporting/);
  dead.store.close();
});

test('the route refuses a swap nobody consented to, and takes one they did', async () => {
  const system = build();
  const { app } = await buildApp(system);
  liveRun(system, 'issue:99', 'issue/99');

  const refused = await app.inject({ method: 'POST', url: '/api/issues/12/validate-locally', payload: {} });
  assert.equal(refused.statusCode, 409);
  const body = refused.json() as { error: string; live: { goal: string } };
  assert.match(body.error, /#99 is running locally on issue\/99/);
  assert.match(body.error, /swap/);
  assert.equal(body.live.goal, 'issue:99');
  assert.equal(system.store.localValidations.latestLocalValidation('issue:12'), null, 'nothing was recorded');

  await app.close();
  system.store.close();
});

test('a second press while one is running is refused, and says what is already happening', async () => {
  const system = build();
  const { app } = await buildApp(system);
  liveRun(system);
  const first = request(system);

  const again = await app.inject({ method: 'POST', url: '/api/issues/12/validate-locally', payload: {} });
  assert.equal(again.statusCode, 409);
  const body = again.json() as { error: string; validation: { id: string } };
  assert.equal(body.validation.id, first.id, 'the refusal carries what is already in flight');

  const cancelled = await app.inject({ method: 'POST', url: '/api/issues/12/validate-locally/cancel' });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(system.store.localValidations.getLocalValidation(first.id)?.status, 'abandoned');

  const missing = await app.inject({ method: 'POST', url: '/api/issues/12/validate-locally/cancel' });
  assert.equal(missing.statusCode, 404, 'there is nothing left to call off');

  await app.close();
  system.store.close();
});

test('with nothing configured to start, the press is refused with the field named', async () => {
  const system = build({ localRun: { instruction: '', url: '' } as never });
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/issues/12/validate-locally', payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /localRun\.instruction/);
  await app.close();
  system.store.close();
});

test('a screenshot is served from the row’s own directory and nowhere else', async () => {
  const system = build();
  const { app } = await buildApp(system);
  liveRun(system);
  const validation = request(system);
  writeFileSync(join(system.localValidations.outputDir(validation), 'shot.png'), 'not really a png');

  const served = await app.inject({ method: 'GET', url: `/local-validations/${validation.id}/files/shot.png` });
  assert.equal(served.statusCode, 200);

  const escaped = await app.inject({
    method: 'GET',
    url: `/local-validations/${validation.id}/files/${encodeURIComponent('../../secret')}`,
  });
  assert.equal(escaped.statusCode, 400);

  await app.close();
  system.store.close();
});

test('the launch document carries both servers, and never lets an extra take the harness’s key', async () => {
  const system = build();
  const listening = await system.mcp.listen();
  assert.ok(listening, 'the fleet socket binds');

  const credential = system.mcp.open([
    { key: 'browser', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    { key: MCP_SERVER_ID, command: 'evil', args: [] },
  ]);
  assert.ok(credential.configPath, 'a listening server writes a launch config');
  const doc = JSON.parse(readFileSync(credential.configPath, 'utf8')) as {
    mcpServers: Record<string, { command: string }>;
  };
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), [MCP_SERVER_ID, 'browser'].sort());
  assert.notEqual(doc.mcpServers[MCP_SERVER_ID]?.command, 'evil', 'ours is not the one that was dropped');

  await system.mcp.close();
  system.store.close();
});

test('every signer the route context declares is forwarded to the snapshot', () => {
  const context = repoText('src/server/routes/context.ts');
  const route = repoText('src/server/routes/state.ts');
  const signers = [...context.matchAll(/^\s{2}(\w*[Ss]igner)\?:/gm)].map((m) => m[1] as string);
  assert.ok(signers.length >= 3, `expected the context to declare signers, found ${String(signers.length)}`);

  const destructure = /export function register\([\s\S]*?\}: RouteContext/.exec(route)?.[0] ?? '';
  const snapshot = route.slice(route.indexOf('buildStateSnapshot(system'));
  for (const signer of signers) {
    assert.ok(destructure.includes(signer), `the state route does not take ${signer} off its context`);
    assert.equal(
      snapshot.split(signer).length - 1,
      2,
      `${signer} must reach both buildStateSnapshot and buildStateSections`,
    );
  }
});

test('a screenshot capability is bound to the one file it names', () => {
  const key = randomBytes(32);
  const sign = localValidationFileSignerFor(key);
  const token = sign('lv1', 'shot.png');
  const now = Date.now();
  assert.ok(verifyArtifactCapability(key, token, 'local-validation:lv1:shot.png', now));
  assert.ok(!verifyArtifactCapability(key, token, 'local-validation:lv1:other.png', now), 'not another file');
  assert.ok(!verifyArtifactCapability(key, token, 'local-validation:lv2:shot.png', now), 'not another validation');
  assert.ok(!verifyArtifactCapability(key, token, 'lv1', now));
});
