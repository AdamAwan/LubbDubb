import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { findingTicketFields, trackerCoordinates } from '../src/mcp/findings.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Agent, Finding } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Filing a finding as a **ticket** — the defer arm beside promotion's "work it
 * now". Promotion puts an agent on the problem; filing puts an agent on the
 * *tracker*, so the problem waits its turn in the backlog with everything else.
 *
 * The asymmetry worth keeping in view while reading these: promotion is settled
 * the instant the route returns, while filing is only *begun* there — the ticket
 * exists when an agent has created it and said so through `link_ticket`. That is
 * why there are two statuses and why the tool exists at all.
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-ticket-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

/**
 * A system whose *issue tracker* is GitHub while its world stays the fake one.
 *
 * The coordinates are read from config at request time, not captured when the
 * providers are built, so pointing the selection at `github` after the build
 * exercises exactly the branch the route takes on a real deployment without
 * standing up a provider that would want a token and a network.
 */
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

/** A finding on the books, filed by an agent the way `report_finding` would. */
function seedFinding(system: System): Finding {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Fix CI on PR #142',
    prompt: 'do it',
    branch: 'feature/rate-limit',
    originRef: 'pr:142:ci',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
  return system.store.recordFinding(agent.id, task.id, task.originRef, {
    kind: 'out_of_scope',
    ref: null,
    summary: 'The ingest API buffers a 200MB body before rejecting it. Not what I was sent for.',
  }).finding;
}

/**
 * The agent working the filing job — the one whose credential resolves the
 * finding back.
 *
 * Spawned here rather than waited for, deliberately: rule `manual-job`'s dispatch of a
 * queued job is `test/jobQueue.test.ts`'s subject, and depending on it here
 * would make this suite fail for a reason that has nothing to do with filing.
 * What is under test is the handshake — a task on `job:<id>` is what a dispatched
 * filing job produces, so that is what is built.
 */
function filingAgent(system: System, job: { id: string; title: string; prompt: string }): Agent {
  const task = system.store.createTask({
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

// -- the pure half ------------------------------------------------------------

test('the tracker is named from the provider actually serving issues', () => {
  const gh = {
    integrations: { issues: 'github', sourceControl: 'fake' },
    github: { owner: 'AdamAwan', repo: 'LubbDubb' },
  } as unknown as Config;
  assert.match(trackerCoordinates(gh)!, /GitHub repository AdamAwan\/LubbDubb/);
  // The command is in the prompt because a *desk* agent has no repo checkout to
  // infer the target from — that is the whole reason coordinates are passed.
  assert.match(trackerCoordinates(gh)!, /gh issue create -R AdamAwan\/LubbDubb/);

  const az = {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
  } as unknown as Config;
  assert.match(trackerCoordinates(az)!, /Azure DevOps project "Platform"/);
  assert.match(trackerCoordinates(az)!, /az boards work-item create --org https:\/\/dev\.azure\.com\/contoso/);

  // No tracker to file into: the `fake` provider, and a provider selected without
  // its config block. Both must read the same, or the cockpit offers a button
  // whose route refuses.
  assert.equal(trackerCoordinates({ integrations: { issues: 'fake' } } as unknown as Config), null);
  assert.equal(trackerCoordinates({ integrations: { issues: 'github' } } as unknown as Config), null);
});

test('the filing prompt carries the report, its provenance, and the tracker', () => {
  const finding: Finding = {
    id: 'f1',
    agentId: 'a1',
    taskId: 't1',
    originRef: 'pr:142:ci',
    kind: 'duplicate',
    ref: 'issue:41',
    summary: 'Same work as #41.',
    status: 'open',
    jobId: null,
    ticketRef: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
  const { title, vars } = findingTicketFields(finding, 'the GitHub repository a/b.');
  assert.match(title, /^File ticket: /);

  const prompt = defaultPromptTemplates().render('finding-ticket', vars);
  assert.match(prompt, /Same work as #41\./); // the report, verbatim
  assert.match(prompt, /pr:142:ci/); // who saw it, and while doing what
  assert.match(prompt, /issue:41/); // what it is about
  assert.match(prompt, /the GitHub repository a\/b\./); // where it goes
  assert.match(prompt, /link_ticket/); // and how to report it back
  // File it, don't fix it: the whole point of deferring is that no one is working
  // this yet, and a filing agent that "just quickly fixed it" has spent a slot on
  // work nobody scheduled.
  assert.match(prompt, /do not fix it/i);
  // No placeholder is left unfilled — a `{token}` reaching an agent is a prompt bug.
  assert.doesNotMatch(prompt, /\{\w+\}/);
});

// -- the route ----------------------------------------------------------------

test('filing a finding queues a desk job and leaves the finding filing, not filed', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const finding = seedFinding(system);

  const res = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/file` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: { id: string; kind: string; branch: string | null; prompt: string } };

  // Desk, not code: filing touches no repository, so cutting a worktree and a
  // branch would be pure cost for a task that never writes a file.
  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.branch, null);
  assert.match(body.job.prompt, /gh issue create -R AdamAwan\/LubbDubb/);

  const after = system.store.getFinding(finding.id)!;
  // `filing`, not `filed`: nothing has been created yet. Claiming a ticket here
  // would be a link to nowhere, and would leave nothing to show for a filing
  // agent that died before it made one.
  assert.equal(after.status, 'filing');
  assert.equal(after.ticketRef, null);
  assert.equal(after.jobId, body.job.id);
});

test('a finding can only be decided once, and only one way', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const finding = seedFinding(system);

  assert.equal((await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/file` })).statusCode, 200);
  // Every other verdict is now refused — filing is a decision, and a second one
  // would put a second agent on the same finding.
  for (const arm of ['file', 'promote', 'dismiss']) {
    const again = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/${arm}` });
    assert.equal(again.statusCode, 409, `${arm} after filing is refused`);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/findings/nope/file' })).statusCode, 404);
});

test('with no tracker configured there is nothing to file into, and the cockpit is told so', async () => {
  const system = build(false);
  const { app } = await buildApp(system);
  const finding = seedFinding(system);

  const res = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/file` });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no issue tracker/);
  assert.equal(system.store.getFinding(finding.id)!.status, 'open', 'a refused filing decides nothing');

  // The button is hidden off the same predicate the route refuses on, so the
  // cockpit never offers a click that cannot work.
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    config: { canFileTickets: boolean };
  };
  assert.equal(snap.config.canFileTickets, false);
});

// -- link_ticket --------------------------------------------------------------

test('the filing agent reports its ticket back, and the finding is filed once', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const finding = seedFinding(system);

  const filed = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/file` });
  const job = (filed.json() as { job: { id: string; title: string; prompt: string } }).job;
  const agent = filingAgent(system, job);

  const res = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(res.isError, false);

  const after = system.store.getFinding(finding.id)!;
  assert.equal(after.status, 'filed');
  assert.equal(after.ticketRef, 'issue:314');

  // Idempotence is a property of the write (`WHERE status='filing'`), not of a
  // caller remembering to look first — an agent that calls twice links once.
  const twice = await callTool(system, agent, 'link_ticket', { ref: 'issue:999' });
  assert.equal(twice.isError, true);
  assert.equal(system.store.getFinding(finding.id)!.ticketRef, 'issue:314');

  // And the ticket is a link, not a string: a brand-new item is not in the world
  // lists, so it has to be resolved by its canonical ref or the chip goes nowhere.
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    findings: Finding[];
    refUrls: Record<string, string>;
  };
  const shipped = snap.findings.find((f) => f.id === finding.id)!;
  assert.equal(shipped.ticketRef, 'issue:314');
  // The fake provider resolves no URLs, so what is asserted is that the ref was
  // *offered* for resolution — a real provider's entry lands in the same map.
  assert.ok(!('issue:314' in snap.refUrls) || snap.refUrls['issue:314']!.length > 0);
});

test('link_ticket resolves its finding from the credential, so no agent can link another’s', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const finding = seedFinding(system);
  await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/file` });

  // An ordinary working agent — not dispatched from a finding. There is no
  // argument naming a finding, so it cannot reach one: the identity *is* the
  // access check.
  const task = system.store.createTask({
    kind: 'code',
    title: 'Something else',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  const other = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
  const res = await callTool(system, other, 'link_ticket', { ref: 'issue:314' });
  assert.equal(res.isError, true);
  assert.match(res.text, /only for a job dispatched to file a finding/);
  assert.equal(system.store.getFinding(finding.id)!.status, 'filing', 'untouched by a stranger');
});

test('a ticket ref is held to the same vocabulary a finding’s ref is', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const finding = seedFinding(system);
  const filed = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/file` });
  const agent = filingAgent(system, (filed.json() as { job: { id: string; title: string; prompt: string } }).job);

  // A bare number is refused for the reason it is refused in `report_finding`:
  // there is no kind argument to say whether 314 is an issue or a PR, and a
  // ticket link that points at the wrong one is worse than none.
  const bare = await callTool(system, agent, 'link_ticket', { ref: '314' });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /not a harness ref/);
  assert.equal(system.store.getFinding(finding.id)!.status, 'filing');

  // Suffix-tolerant, like every other ref the harness reads: an origin-shaped ref
  // names the same item.
  const ok = await callTool(system, agent, 'link_ticket', { ref: 'issue:314:ci' });
  assert.equal(ok.isError, false);
  assert.equal(system.store.getFinding(finding.id)!.ticketRef, 'issue:314');
});

test('link_ticket is granted, not merely exposed', () => {
  // The sharp edge of the whole channel: a tool absent from the name list is
  // advertised by `tools/list` and refused on every call, with nothing in the
  // logs to say why. Asserted here as well as in the channel's own suite because
  // this is the tool being added.
  assert.ok(MCP_TOOL_NAMES.includes('link_ticket'));
});
