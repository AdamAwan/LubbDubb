import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext, DispatchResult } from '../src/dispatcher/dispatcher.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import Database from 'better-sqlite3';
import { investigationNote, investigationStanding, investigationStandings } from '../src/intake/investigation.js';
import { Store } from '../src/store/store.js';
import { investigateLabelFor, pickupLabels } from '../src/watchLabels.js';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { MCP_TOOL_NAMES, RULE_TOOLS, TOOL_NAMING } from '../src/mcp/names.js';
import type { Agent, Decision, Issue, IssueAppraisal, IssueInvestigation, Task } from '../src/types.js';

const NOW = '2026-10-14T12:00:00.000Z';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Export crashes',
    body: 'Exporting an empty report throws.',
    labels: ['investigate'],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function workable(i: Issue = issue()): IssueAppraisal {
  return {
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'A crash on an empty export.',
    missing: [],
    goalRef: goalFingerprint(i.title, i.body),
    by: 'appraiser',
    proposedProfile: null,
    profileAnsweredAt: null,
    proposedParent: null,
    parentSettledAt: null,
    proposedAreaPath: null,
    areaPathSettledAt: null,
    agentId: null,
    taskId: null,
    commentRef: null,
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

function investigation(over: Partial<IssueInvestigation> = {}): IssueInvestigation {
  const i = issue();
  return {
    originRef: 'issue:12',
    goalRef: goalFingerprint(i.title, i.body),
    by: 'a1',
    reproduction: 'Export a report with no rows.',
    rootCause: 'reduce() with no initial value on an empty array',
    confidence: 'high',
    locations: 'src/export/csv.ts:42',
    blastRadius: 'Only the CSV export.',
    recommendation: 'plan',
    decidedAt: NOW,
    resolution: null,
    resolvedAt: null,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}, i: Issue = issue()): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [i] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    appraisals: [workable(i)],
    ...over,
  };
}

function origins(result: DispatchResult): string[] {
  return result.actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => (a as { originRef?: string }).originRef ?? '');
}

function dispatched(result: DispatchResult, origin: string): { prompt: string; branch: string; readOnly?: boolean } {
  const action = result.actions.find((a) => (a as { originRef?: string }).originRef === origin);
  assert.ok(action, `nothing dispatched for ${origin}`);
  return action as unknown as { prompt: string; branch: string; readOnly?: boolean };
}

function queued(result: DispatchResult, origin: string) {
  return result.upcoming?.find((q) => q.origin === origin);
}

function spentCap(origin: string, branch: string): Decision[] {
  return [1, 2, 3].map((n) => ({
    id: `d${n}`,
    cycleId: `c${n}`,
    action: { type: 'dispatch_code_agent', branch, title: 'x', prompt: 'x', originRef: origin, reason: 'x' },
    outcome: 'executed',
    rule: 'issue-investigate',
    admission: null,
    detail: '',
    createdAt: '2026-10-13T00:00:00.000Z',
  })) as Decision[];
}

function running(originRef: string): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Investigate',
    prompt: 'x',
    branch: 'investigate/issue/12',
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test('the label is <prefix>-investigate, or bare without a prefix', () => {
  assert.equal(investigateLabelFor('lubbdubb'), 'lubbdubb-investigate');
  assert.equal(investigateLabelFor(''), 'investigate');
  const tagged = { labels: ['investigate'], labelsAddedByViewer: [] };
  assert.equal(pickupLabels(tagged, false).includes('investigate'), true);
  assert.equal(pickupLabels(tagged, true).includes('investigate'), false, 'own-label mode reads authorship');
});

test('a labelled issue is investigated, read-only, before it is planned', async () => {
  const result = await new RuleDispatcher().decide(ctx());
  assert.deepEqual(origins(result), ['issue:12:investigate']);
  const action = dispatched(result, 'issue:12:investigate');
  assert.equal(action.branch, 'investigate/issue/12');
  assert.equal(action.readOnly, true);
  assert.match(action.prompt, /Investigate, do not fix/);
  assert.equal(queued(result, 'issue:12:plan')?.status, 'superseded', 'the planner stands aside');
});

test('without the label nothing is investigated', async () => {
  const result = await new RuleDispatcher().decide(ctx({}, issue({ labels: [] })));
  assert.deepEqual(origins(result), ['issue:12:plan']);
});

test('the label is read under requireOwnLabel exactly like the watch label', async () => {
  const d = new RuleDispatcher({ pickup: { requireOwnLabel: true } });
  const notMine = issue({ labelsAddedByViewer: [] });
  assert.deepEqual(origins(await d.decide(ctx({}, notMine))), ['issue:12:plan']);
  const mine = issue({ labelsAddedByViewer: ['investigate'] });
  assert.deepEqual(origins(await d.decide(ctx({}, mine))), ['issue:12:investigate']);
});

test('the appraisal goes first — a labelled issue still being appraised is not investigated', async () => {
  const result = await new RuleDispatcher().decide(ctx({ appraisals: [] }));
  assert.deepEqual(origins(result), ['issue:12:appraisal']);
});

test('a running investigator holds plan and pickup', async () => {
  const result = await new RuleDispatcher().decide(ctx({ tasks: [running('issue:12:investigate')] }));
  assert.deepEqual(origins(result), []);
  assert.equal(queued(result, 'issue:12:plan')?.status, 'superseded');
});

test('unresolved findings hold plan and pickup until the operator answers', async () => {
  const result = await new RuleDispatcher().decide(ctx({ investigations: [investigation()] }));
  assert.deepEqual(origins(result), [], 'not re-investigated, and not planned');
  const plan = queued(result, 'issue:12:plan');
  assert.equal(plan?.status, 'superseded');
  assert.match(plan?.reason ?? '', /waiting on you/);
});

test('removing the label lifts every hold', async () => {
  const unlabelled = issue({ labels: [] });
  const unresolved = await new RuleDispatcher().decide(ctx({ investigations: [investigation()] }, unlabelled));
  assert.deepEqual(origins(unresolved), ['issue:12:plan']);
  const closed = await new RuleDispatcher().decide(
    ctx({ investigations: [investigation({ resolution: 'close' })] }, unlabelled),
  );
  assert.deepEqual(origins(closed), ['issue:12:plan']);
});

test('an edit to the ticket re-arms the investigation', async () => {
  const result = await new RuleDispatcher().decide(
    ctx({ investigations: [investigation({ goalRef: goalFingerprint('old', 'text') })] }),
  );
  assert.deepEqual(origins(result), ['issue:12:investigate']);
});

test('resolved to plan, the planner runs with the findings appended', async () => {
  const result = await new RuleDispatcher().decide(ctx({ investigations: [investigation({ resolution: 'plan' })] }));
  assert.deepEqual(origins(result), ['issue:12:plan']);
  const prompt = dispatched(result, 'issue:12:plan').prompt;
  assert.match(prompt, /What the investigation found/);
  assert.match(prompt, /reduce\(\) with no initial value/);
  assert.ok(prompt.indexOf('What the investigation found') > prompt.indexOf('Export crashes'), 'appended');
});

test('a pickup answer from before it was withdrawn reads as plan', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-investigation-')), 'store.db');
  const first = new Store(dbPath);
  first.investigations.record({ ...FINDINGS_ROW, goalRef: 'g' });
  first.close();
  const raw = new Database(dbPath);
  raw.prepare("UPDATE issue_investigations SET recommendation = 'pickup', resolution = 'pickup'").run();
  raw.close();
  const second = new Store(dbPath);
  const row = second.investigations.get('issue:12');
  assert.equal(row?.recommendation, 'plan');
  assert.equal(row?.resolution, 'plan');
  second.close();
});

test('resolved to close or ask, the issue stays held while the label is on', async () => {
  for (const resolution of ['close', 'ask'] as const) {
    const result = await new RuleDispatcher().decide(ctx({ investigations: [investigation({ resolution })] }));
    assert.deepEqual(origins(result), [], `${resolution} dispatches nothing`);
    assert.equal(queued(result, 'issue:12:plan')?.status, 'superseded');
  }
});

test('a spent attempt cap fails open to the funnel, with no escalation', async () => {
  const result = await new RuleDispatcher().decide(
    ctx({ recentDecisions: spentCap('issue:12:investigate', 'investigate/issue/12') }),
  );
  assert.deepEqual(origins(result), ['issue:12:plan']);
  assert.ok(!result.actions.some((a) => a.type === 'escalate_to_human'));
});

test('report_investigation is named, placed and only handed to the investigator', () => {
  assert.ok(MCP_TOOL_NAMES.includes('report_investigation'));
  assert.equal(TOOL_NAMING.report_investigation, 'point-of-use');
  assert.deepEqual(RULE_TOOLS['issue-investigate'], ['report_investigation']);
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-investigate-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function spawnAgent(system: System, originRef: string, over: Partial<Task> = {}): Agent {
  const t = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'investigate/issue/12',
    originRef,
    originTitle: issue().title,
    originSummary: issue().body,
    ...over,
  });
  return system.agents.spawn(t, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session);
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const FINDINGS = {
  reproduction: 'Export a report with no rows.',
  root_cause: 'reduce() with no initial value',
  confidence: 'high',
  locations: 'src/export/csv.ts:42',
  blast_radius: 'Only the CSV export.',
  recommendation: 'plan',
};

test('the investigator records its findings against the text it was handed', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:investigate');
  const res = await callTool(system, agent, 'report_investigation', FINDINGS);
  assert.equal(res.isError, false, res.text);
  const row = system.store.investigations.get('issue:12');
  assert.equal(row?.by, agent.id);
  assert.equal(row?.goalRef, goalFingerprint(issue().title, issue().body));
  assert.equal(row?.recommendation, 'plan');
  assert.equal(row?.resolution, null);
  system.store.close?.();
});

test('an investigator told to recommend pickup by an old override is recorded as plan', async () => {
  const system = build();
  const res = await callTool(system, spawnAgent(system, 'issue:12:investigate'), 'report_investigation', {
    ...FINDINGS,
    recommendation: 'pickup',
  });
  assert.equal(res.isError, false, res.text);
  assert.equal(system.store.investigations.get('issue:12')?.recommendation, 'plan');
  system.store.close?.();
});

test('report_investigation is fenced to the investigator’s origin', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');
  const res = await callTool(system, agent, 'report_investigation', FINDINGS);
  assert.equal(res.isError, true);
  assert.equal(system.store.investigations.get('issue:12'), null);
  system.store.close?.();
});

test('an appraisal asking for investigation labels the issue once, at record time', async () => {
  const system = build();
  const writes: { number: number; label: string; present: boolean }[] = [];
  (system.connector as unknown as { setIssueLabel: (i: (typeof writes)[number]) => Promise<unknown> }).setIssueLabel =
    async (input) => {
      writes.push({ number: input.number, label: input.label, present: input.present });
      return { ok: true };
    };
  const agent = spawnAgent(system, 'issue:12:appraisal');
  const res = await callTool(system, agent, 'appraise_issue', {
    status: 'workable',
    summary: 'A crash on an empty export, cause unknown.',
    investigate: true,
  });
  assert.equal(res.isError, false, res.text);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(writes, [{ number: 12, label: 'investigate', present: true }]);

  await callTool(system, agent, 'appraise_issue', { status: 'workable', summary: 'Same reading.' });
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 1, 'only an appraisal that asks applies it');

  await callTool(system, agent, 'appraise_issue', {
    status: 'unclear',
    summary: 'No idea what it is.',
    missing: ['What happens?'],
    investigate: true,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 1, 'an unclear goal is never sent to an investigator');
  system.store.close?.();
});

const FINDINGS_ROW = {
  originRef: 'issue:12',
  by: 'a1',
  reproduction: 'r',
  rootCause: 'c',
  confidence: 'low' as const,
  locations: 'l',
  blastRadius: 'b',
  recommendation: 'ask' as const,
};

type LabelWrite = { number: number; label: string; present: boolean };

function scriptLabels(system: System, write: (input: LabelWrite) => Promise<unknown>): void {
  (system.connector as unknown as { setIssueLabel: typeof write }).setIssueLabel = write;
}

test('the label is in the world before the appraisal verdict that would release the planner', async () => {
  const system = build();
  system.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [], issues: [issue({ labels: [] })] });
  let land!: () => void;
  scriptLabels(system, () => new Promise((resolve) => (land = () => resolve({ ok: true }))));
  const agent = spawnAgent(system, 'issue:12:appraisal');
  const call = callTool(system, agent, 'appraise_issue', {
    status: 'workable',
    summary: 'A crash on an empty export, cause unknown.',
    investigate: true,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(system.store.verdicts.getAppraisal('issue:12'), null, 'the verdict landed before the label');
  land();
  const res = await call;
  assert.equal(res.isError, false, res.text);
  assert.equal(system.store.verdicts.getAppraisal('issue:12')?.verdict, 'workable');
  assert.ok(system.store.world.getWorldBaseline()?.issues[0]?.labels?.includes('investigate'));
  system.store.close?.();
});

test('the harness applies the investigate label once per issue, ever', async () => {
  const system = build();
  const writes: LabelWrite[] = [];
  scriptLabels(system, async (input) => {
    writes.push(input);
    return { ok: true };
  });
  const asks = { status: 'workable', summary: 'Cause unknown.', investigate: true };
  await callTool(system, spawnAgent(system, 'issue:12:appraisal'), 'appraise_issue', asks);
  assert.equal(writes.length, 1);
  await callTool(system, spawnAgent(system, 'issue:12:appraisal'), 'appraise_issue', asks);
  assert.equal(writes.length, 1, 'a re-appraisal put back a label the operator may have removed');
  system.store.close?.();
});

test('a failed label write is recorded, still records the verdict, and does not count as applied', async () => {
  const system = build();
  let attempts = 0;
  scriptLabels(system, async () => {
    attempts++;
    throw new Error('tracker down');
  });
  const asks = { status: 'workable', summary: 'Cause unknown.', investigate: true };
  const res = await callTool(system, spawnAgent(system, 'issue:12:appraisal'), 'appraise_issue', asks);
  assert.equal(res.isError, false, res.text);
  assert.equal(system.store.verdicts.getAppraisal('issue:12')?.verdict, 'workable');
  assert.ok(system.store.errors.listErrors().some((e) => e.message.includes('tracker down')));
  await callTool(system, spawnAgent(system, 'issue:12:appraisal'), 'appraise_issue', asks);
  assert.equal(attempts, 2, 'a write that never landed is not the once');
  system.store.close?.();
});

test('with the label off, a resolved investigation appends nothing', () => {
  const current = investigation({ resolution: 'plan', resolvedAt: NOW });
  const standing = (labels: string[]) =>
    investigationStanding(
      investigationStandings([issue({ labels })], [current], { investigateLabel: 'investigate' }),
      12,
    );
  assert.match(investigationNote(standing(['investigate'])), /What the investigation found/);
  assert.equal(investigationNote(standing([])), '');
  assert.equal(standing([]).current, current, 'the findings still read as current with the label off');
  assert.equal(standing([]).inForce, null);
});

test('the route refuses to resolve findings about an earlier text of the ticket', async () => {
  const system = build();
  system.store.world.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    issues: [issue({ body: 'Rewritten: it throws on a single row too.' })],
  });
  system.store.investigations.record({ ...FINDINGS_ROW, goalRef: goalFingerprint(issue().title, issue().body) });
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/investigation',
    payload: { resolution: 'plan' },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(system.store.investigations.get('issue:12')?.resolution, null);
  await app.close();
  system.store.close?.();
});

test('the route refuses to resolve findings for an issue missing from the world snapshot', async () => {
  const system = build();
  system.store.investigations.record({ ...FINDINGS_ROW, goalRef: goalFingerprint(issue().title, issue().body) });
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/investigation',
    payload: { resolution: 'plan' },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /world snapshot/);
  assert.equal(system.store.investigations.get('issue:12')?.resolution, null);
  await app.close();
  system.store.close?.();
});

test('the route refuses to resolve current findings once the label is off', async () => {
  const system = build();
  system.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [], issues: [issue({ labels: [] })] });
  system.store.investigations.record({ ...FINDINGS_ROW, goalRef: goalFingerprint(issue().title, issue().body) });
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/investigation',
    payload: { resolution: 'plan' },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /label/);
  assert.equal(system.store.investigations.get('issue:12')?.resolution, null);
  await app.close();
  system.store.close?.();
});

test('the operator resolves or clears the findings over the route', async () => {
  const system = build();
  system.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [], issues: [issue()] });
  system.store.investigations.record({ ...FINDINGS_ROW, goalRef: goalFingerprint(issue().title, issue().body) });
  const { app } = await buildApp(system);
  const bad = await app.inject({ method: 'POST', url: '/api/issues/12/investigation', payload: { resolution: 'x' } });
  assert.equal(bad.statusCode, 400);
  const pickup = await app.inject({
    method: 'POST',
    url: '/api/issues/12/investigation',
    payload: { resolution: 'pickup' },
  });
  assert.equal(pickup.statusCode, 400, 'a fix is never sent straight to pickup');
  const resolved = await app.inject({
    method: 'POST',
    url: '/api/issues/12/investigation',
    payload: { resolution: 'plan' },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(system.store.investigations.get('issue:12')?.resolution, 'plan');
  const cleared = await app.inject({ method: 'POST', url: '/api/issues/12/investigation', payload: { clear: true } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(system.store.investigations.get('issue:12'), null);
  const missing = await app.inject({
    method: 'POST',
    url: '/api/issues/12/investigation',
    payload: { resolution: 'plan' },
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
  system.store.close?.();
});
