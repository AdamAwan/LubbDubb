import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { bugTicketFields } from '../src/bugFiling.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import type { Agent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-raisebug-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function build(withTracker = true): System {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  if (withTracker) {
    system.config.integrations.issues = 'github';
    system.config.github = { owner: 'AdamAwan', repo: 'LubbDubb' };
  }
  return system;
}

async function seedWorld(system: System, number = 12): Promise<number> {
  system.connector.inject({
    kind: 'new_issue',
    number,
    title: 'Export the ledger as CSV',
    body: 'the ledger should download as a CSV',
  });
  system.store.world.setWorldBaseline(await system.connector.getState());
  return number;
}

function filingAgent(system: System, job: { id: string; title: string; prompt: string }): Agent {
  const task = system.store.tasks.createTask({
    kind: 'desk',
    title: job.title,
    prompt: job.prompt,
    branch: null,
    originRef: `job:${job.id}`,
    originTitle: job.title,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-desk-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('the prompt carries the operator’s words verbatim and says whose they are', () => {
  const { title, vars } = bugTicketFields(
    { number: 12, title: 'Export the ledger as CSV' },
    'The export button still 404s on Safari.\nWorked in the PR preview, not on main.',
    'the GitHub repository a/b.',
  );
  assert.match(title, /^Raise bug on #12: /);

  const prompt = defaultPromptTemplates().render('raise-bug', vars);
  assert.match(prompt, /The export button still 404s on Safari\./);
  assert.match(prompt, /Worked in the PR preview, not on main\./);
  assert.match(prompt, /#12/);
  assert.match(prompt, /the GitHub repository a\/b\./);
  assert.match(prompt, /link_ticket/);
  assert.doesNotMatch(prompt, /gh issue create|az boards work-item/);
  assert.match(prompt, /do not fix it/i);
  assert.match(prompt, /operator speaking, not an agent/i);
  assert.doesNotMatch(prompt, /\{\w+\}/);
});

test('raising a bug queues a desk job carrying the report, and files nothing yet', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const res = await app.inject({
    method: 'POST',
    url: `/api/issues/${number}/bug`,
    payload: { summary: 'The export button still 404s on Safari.' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    job: { id: string; kind: string; branch: string | null; prompt: string };
    filing: { status: string; ticketRef: string | null; originRef: string };
  };

  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.branch, null);
  assert.match(body.job.prompt, /The export button still 404s on Safari\./);
  assert.match(body.job.prompt, /the GitHub repository AdamAwan\/LubbDubb/);

  assert.equal(body.filing.status, 'filing');
  assert.equal(body.filing.ticketRef, null);
  assert.equal(body.filing.originRef, `issue:${number}`);
});

test('the story’s own verdict is left exactly where it was', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const before = system.store.verdicts.getIssueConclusion(`issue:${number}`);
  await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload: { summary: 'Still broken.' } });

  assert.deepEqual(system.store.verdicts.getIssueConclusion(`issue:${number}`), before);
  assert.equal(system.store.verdicts.getShortfall(`issue:${number}`), null);
});

test('a story can carry several bugs, because it can be wrong in several ways', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  for (const summary of ['404s on Safari.', 'The CSV has no header row.']) {
    const res = await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload: { summary } });
    assert.equal(res.statusCode, 200);
  }
  const filings = system.store.bugFilings.listBugFilings().filter((b) => b.originRef === `issue:${number}`);
  assert.equal(filings.length, 2);
  assert.equal(new Set(filings.map((f) => f.jobId)).size, 2, 'each raise gets its own job');
});

test('an empty report asks for nothing, and an unseen issue is a 404', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  for (const payload of [{}, { summary: '   ' }]) {
    const res = await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} is refused`);
  }
  const unseen = await app.inject({ method: 'POST', url: '/api/issues/98765/bug', payload: { summary: 'x' } });
  assert.equal(unseen.statusCode, 404);
  assert.equal(system.store.bugFilings.listBugFilings().length, 0, 'a refused raise files nothing');
});

test('with no tracker configured there is nothing to file into, and the cockpit is told so', async () => {
  const system = build(false);
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const res = await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload: { summary: 'Broken.' } });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no issue tracker/);
  assert.equal(system.store.bugFilings.listBugFilings().length, 0);

  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    config: { canFileTickets: boolean };
  };
  assert.equal(snap.config.canFileTickets, false);
});

test('link_ticket completes the raise, once, and only with an issue ref', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const res = await app.inject({
    method: 'POST',
    url: `/api/issues/${number}/bug`,
    payload: { summary: 'The export button still 404s on Safari.' },
  });
  const { job } = res.json() as { job: { id: string; title: string; prompt: string } };
  const agent = filingAgent(system, job);

  const wrong = await callTool(system, agent, 'link_ticket', { ref: 'pr:42' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /issue:314|must be an issue ref/);
  assert.equal(system.store.bugFilings.findBugFilingByJobId(job.id)!.status, 'filing');

  const ok = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(ok.isError, false);
  const filed = system.store.bugFilings.findBugFilingByJobId(job.id)!;
  assert.equal(filed.status, 'filed');
  assert.equal(filed.ticketRef, 'issue:314');

  const again = await callTool(system, agent, 'link_ticket', { ref: 'issue:999' });
  assert.equal(again.isError, true);
  assert.equal(system.store.bugFilings.findBugFilingByJobId(job.id)!.ticketRef, 'issue:314');
});

test('an agent on any other task has no bug to link', async () => {
  const system = build();
  await buildApp(system);
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Fix CI',
    prompt: 'do it',
    branch: 'issue/9',
    originRef: 'pr:142:ci',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

  const res = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(res.isError, true);
  assert.match(res.text, /raise a bug an operator reported|none of them/);
});

test('link_ticket files the bug the agent wrote, related to the story, without being asked to', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const res = await app.inject({
    method: 'POST',
    url: `/api/issues/${number}/bug`,
    payload: { summary: 'The export button still 404s on Safari.' },
  });
  const { job } = res.json() as { job: { id: string; title: string; prompt: string } };
  const agent = filingAgent(system, job);

  const ok = await callTool(system, agent, 'link_ticket', {
    title: 'CSV export 404s on Safari',
    body: 'Reported by the operator; reproduced against `main`.',
  });
  assert.equal(ok.isError, false);

  const filed = system.store.bugFilings.findBugFilingByJobId(job.id)!;
  assert.equal(filed.status, 'filed');
  assert.ok(filed.ticketRef?.startsWith('issue:'), 'the harness reports back the ref it created');

  const world = await system.connector.getState();
  const bug = world.issues.find((i) => `issue:${i.number}` === filed.ticketRef)!;
  assert.equal(bug.title, 'CSV export 404s on Safari');
  assert.match(bug.body, /Reported by the operator/);
  assert.match(bug.body, new RegExp(`Related to #${number}\\.`));
});

test('link_ticket refuses a call that both names an existing item and writes a new one', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);
  const res = await app.inject({
    method: 'POST',
    url: `/api/issues/${number}/bug`,
    payload: { summary: 'Still broken.' },
  });
  const { job } = res.json() as { job: { id: string; title: string; prompt: string } };
  const agent = filingAgent(system, job);

  const both = await callTool(system, agent, 'link_ticket', { ref: 'issue:7', title: 't', body: 'b' });
  assert.equal(both.isError, true);
  assert.match(both.text, /not both/);

  const neither = await callTool(system, agent, 'link_ticket', { title: 'only a title' });
  assert.equal(neither.isError, true);
  assert.match(neither.text, /needs `title` and `body`/);
  assert.equal(system.store.bugFilings.findBugFilingByJobId(job.id)!.status, 'filing');
});
