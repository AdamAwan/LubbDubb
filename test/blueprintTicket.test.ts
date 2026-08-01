import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { blueprintTicketFields } from '../src/blueprintTicket.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Agent, Job, WorkItemFiling } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * An injected code **blueprint** enters the workflow through the same door as a
 * ticket (issue #198): when a tracker is configured, `POST /api/jobs` does not
 * dispatch it onto a branch but files a *watched* ticket, so it flows through the
 * planning funnel like any picked-up issue. The whole change is at route time —
 * rule `manual-job` is untouched.
 *
 * The one thing a finding-filed ticket does not need and a blueprint does: the
 * issue must carry the effective `-watch` label, or the watch gate never picks it
 * up. That is what the label placeholder in the prompt is for.
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-blueprint-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: 'lubbdubb',
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

/** A system whose *issue tracker* is GitHub while its world stays the fake one. */
function build(withTracker = true, configOverrides: Record<string, unknown> = {}): System {
  const system = buildSystem(testConfig(configOverrides), {
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

/** The desk agent the blueprint's filing job dispatches as — the credential `link_ticket` resolves. */
function filingAgent(system: System, job: Job): Agent {
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

test('the filing prompt carries the request, the tracker, and the watch label', () => {
  const { title, vars } = blueprintTicketFields(
    'Add a rate limiter to the ingest API\nit keeps falling over',
    'the GitHub repository a/b.',
    'lubbdubb-watch',
  );
  assert.match(title, /^File ticket: Add a rate limiter/);

  const prompt = defaultPromptTemplates().render('blueprint-ticket', vars);
  assert.match(prompt, /Add a rate limiter to the ingest API/); // the request, verbatim
  assert.match(prompt, /the GitHub repository a\/b\./); // where it goes
  assert.match(prompt, /lubbdubb-watch/); // the label the funnel watches
  assert.match(prompt, /link_ticket/); // how to report it back
  // File the ticket, don't do the work: the whole point is that the funnel plans
  // and dispatches it, so a blueprint agent that "just built it" has bypassed the
  // gates the ticket exists to route it through.
  assert.match(prompt, /do not do the work/i);
  // No placeholder is left unfilled — a `{token}` reaching an agent is a prompt bug.
  assert.doesNotMatch(prompt, /\{\w+\}/);
});

test('an empty watch label (act-on-all) tells the agent no label is needed', () => {
  const { vars } = blueprintTicketFields('Do a thing', 'the tracker.', '');
  const prompt = defaultPromptTemplates().render('blueprint-ticket', vars);
  // labelPrefix '' turns the watch gate off — the harness picks up every issue,
  // so instructing the agent to tag a `` label would be a bug.
  assert.match(prompt, /no label is required/i);
  assert.doesNotMatch(prompt, /\{\w+\}/);
});

// -- the route ----------------------------------------------------------------

test('a code blueprint with a tracker is filed as a watched ticket, not dispatched', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'Add a rate limiter to the ingest API', kind: 'code' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: Job; filing: WorkItemFiling };

  // Desk, not code: filing touches no repository, so no worktree and no branch.
  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.branch, null);
  // The prompt names the tracker and the watch label the funnel keys on.
  assert.match(body.job.prompt, /gh issue create -R AdamAwan\/LubbDubb/);
  assert.match(body.job.prompt, /lubbdubb-watch/);
  assert.match(body.job.prompt, /Add a rate limiter to the ingest API/);

  // A filing row keyed to the desk job is how link_ticket resolves the created
  // issue back. `filing`, not `filed`: no ticket exists until the agent makes one.
  assert.equal(body.filing.jobId, body.job.id);
  assert.equal(body.filing.targetRef, `job:${body.job.id}`);
  assert.equal(body.filing.status, 'filing');
  assert.equal(system.store.findWorkItemFilingByJobId(body.job.id)!.status, 'filing');
});

test('a code blueprint with no tracker dispatches directly, as before', async () => {
  const system = build(false); // fake issues provider — nowhere to file
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: 'Do the thing', kind: 'code' } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: Job; filing?: WorkItemFiling };
  // Unchanged fallback: a code job on the raw prompt, no ticket in between.
  assert.equal(body.job.kind, 'code');
  assert.equal(body.job.prompt, 'Do the thing');
  assert.equal(body.filing, undefined);
});

test('a desk blueprint dispatches directly even when a tracker is configured', async () => {
  const system = build(); // tracker configured
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'Write me a report on X', kind: 'desk' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: Job; filing?: WorkItemFiling };
  // A desk blueprint is already off the branch-cutting path; it is dispatched as
  // asked, on its own prompt, with no ticket filed in between.
  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.prompt, 'Write me a report on X');
  assert.equal(body.filing, undefined);
});

// -- link_ticket --------------------------------------------------------------

test('the blueprint filing agent reports its ticket back through link_ticket', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const filed = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: 'Build X', kind: 'code' } });
  const job = (filed.json() as { job: Job }).job;
  const agent = filingAgent(system, job);

  const ok = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(ok.isError, false);
  const linked = system.store.findWorkItemFilingByJobId(job.id)!;
  assert.equal(linked.status, 'filed');
  assert.equal(linked.ticketRef, 'issue:314');

  // A work item is an issue in both trackers — a PR ref is refused, so a mislink
  // leaves the filing awaiting a real ticket rather than pointing at a PR.
  const wrong = await callTool(system, agent, 'link_ticket', { ref: 'pr:42' });
  assert.equal(wrong.isError, true);
});
