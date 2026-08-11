import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { bugTicketFields, bugTrackerCoordinates } from '../src/bugFiling.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Agent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Raising a **bug** against a story: the operator ran the thing and it does not do
 * what they expect.
 *
 * The distinction these hold in place is what the feature is for. Every other
 * operator control on a story row writes the harness's own verdict about *that
 * story*; this one files new work into the tracker and leaves the story exactly
 * where it found it. Fold the two together and the operator's words — the one fact
 * about a goal no agent on it can derive — end up on a row that carries no words.
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-raisebug-'));
  return loadConfig({
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

/**
 * A system whose issue tracker is GitHub while its world stays the fake one —
 * `findingTickets.test.ts`'s seam, for its reason: the coordinates are read from
 * config at request time, so pointing the selection at a real provider after the
 * build exercises the route's actual branch without a token or a network.
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

/** The world the route checks against — an issue it has never seen is a 404. */
async function seedWorld(system: System, number = 12): Promise<number> {
  system.connector.inject({
    kind: 'new_issue',
    number,
    title: 'Export the ledger as CSV',
    body: 'the ledger should download as a CSV',
  });
  system.store.setWorldBaseline(await system.connector.getState());
  return number;
}

/**
 * The agent working the filing job, whose credential resolves the bug back.
 * Spawned rather than waited for, as in `findingTickets.test.ts`: the dispatch of
 * a queued job is another suite's subject, and what is under test here is the
 * handshake.
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

test('the bug coordinates carry the type and the link back, in each provider’s own vocabulary', () => {
  const gh = {
    integrations: { issues: 'github', sourceControl: 'fake' },
    github: { owner: 'AdamAwan', repo: 'LubbDubb' },
  } as unknown as Config;
  assert.match(bugTrackerCoordinates(gh, 12)!, /gh issue create -R AdamAwan\/LubbDubb/);
  // GitHub's cross-reference *is* its related link, so the story number has to
  // reach the body — naming it is the whole mechanism.
  assert.match(bugTrackerCoordinates(gh, 12)!, /#12/);

  const az = {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
  } as unknown as Config;
  const coords = bugTrackerCoordinates(az, 12)!;
  // A Bug, not the Task `trackerCoordinates` files — the two differ, which is why
  // this is a sibling function rather than a flag on that one.
  assert.match(coords, /--type Bug/);
  // `related`, not parent/child: legal whatever process template the project runs,
  // where a parent link from a User Story to a Bug is refused by some of them.
  assert.match(coords, /--relation-type related --target-id 12/);

  // Nothing to file into: both must read the same as `trackerCoordinates`, or the
  // cockpit offers a button whose route refuses.
  assert.equal(bugTrackerCoordinates({ integrations: { issues: 'fake' } } as unknown as Config, 1), null);
  assert.equal(bugTrackerCoordinates({ integrations: { issues: 'github' } } as unknown as Config, 1), null);
});

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
  assert.match(prompt, /#12/); // the story it came from
  assert.match(prompt, /the GitHub repository a\/b\./); // where it goes
  assert.match(prompt, /link_ticket/); // and how to report it back
  // File it, don't fix it — the same rule the other filing prompts state, and the
  // reason this is a desk job.
  assert.match(prompt, /do not fix it/i);
  // The operator is not an agent, and an agent that treats their report as one
  // more opinion will narrow the bug to whatever it happened to find.
  assert.match(prompt, /operator speaking, not an agent/i);
  // No placeholder is left unfilled — a `{token}` reaching an agent is a prompt bug.
  assert.doesNotMatch(prompt, /\{\w+\}/);
});

// -- the route ----------------------------------------------------------------

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

  // Desk, not code: filing touches no repository.
  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.branch, null);
  assert.match(body.job.prompt, /The export button still 404s on Safari\./);
  assert.match(body.job.prompt, /gh issue create -R AdamAwan\/LubbDubb/);

  // `filing`, not `filed`: nothing exists in the tracker yet, and claiming a ref
  // here would be a link to nowhere.
  assert.equal(body.filing.status, 'filing');
  assert.equal(body.filing.ticketRef, null);
  assert.equal(body.filing.originRef, `issue:${number}`);
});

test('the story’s own verdict is left exactly where it was', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const before = system.store.getIssueConclusion(`issue:${number}`);
  await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload: { summary: 'Still broken.' } });

  // The whole design turns on this: the bug carries the work, so nothing about the
  // story changes. A `more_work` written here would put a second agent on a goal
  // whose brief carries none of the operator's words.
  assert.deepEqual(system.store.getIssueConclusion(`issue:${number}`), before);
  assert.equal(system.store.getShortfall(`issue:${number}`), null);
});

test('a story can carry several bugs, because it can be wrong in several ways', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  for (const summary of ['404s on Safari.', 'The CSV has no header row.']) {
    const res = await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload: { summary } });
    assert.equal(res.statusCode, 200);
  }
  // Two rows, not one refused — the difference from `work_item_filings`, whose
  // target key deliberately allows a node exactly one filing.
  const filings = system.store.listBugFilings().filter((b) => b.originRef === `issue:${number}`);
  assert.equal(filings.length, 2);
  assert.equal(new Set(filings.map((f) => f.jobId)).size, 2, 'each raise gets its own job');
});

test('an empty report asks for nothing, and an unseen issue is a 404', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  // Required where every other body on this surface takes an optional summary: the
  // operator's report *is* the feature.
  for (const payload of [{}, { summary: '   ' }]) {
    const res = await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} is refused`);
  }
  const unseen = await app.inject({ method: 'POST', url: '/api/issues/98765/bug', payload: { summary: 'x' } });
  assert.equal(unseen.statusCode, 404);
  assert.equal(system.store.listBugFilings().length, 0, 'a refused raise files nothing');
});

test('with no tracker configured there is nothing to file into, and the cockpit is told so', async () => {
  const system = build(false);
  const { app } = await buildApp(system);
  const number = await seedWorld(system);

  const res = await app.inject({ method: 'POST', url: `/api/issues/${number}/bug`, payload: { summary: 'Broken.' } });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no issue tracker/);
  assert.equal(system.store.listBugFilings().length, 0);

  // The button is hidden off the same flag the route refuses on, so the cockpit
  // never offers a click that cannot work.
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    config: { canFileTickets: boolean };
  };
  assert.equal(snap.config.canFileTickets, false);
});

// -- link_ticket, the other half of the handshake -----------------------------

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

  // A work item is an issue in both trackers the harness reads, so a `pr:` ref is
  // refused rather than recorded as a bug nobody can open.
  const wrong = await callTool(system, agent, 'link_ticket', { ref: 'pr:42' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /issue:314|must be an issue ref/);
  assert.equal(system.store.findBugFilingByJobId(job.id)!.status, 'filing');

  const ok = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(ok.isError, false);
  const filed = system.store.findBugFilingByJobId(job.id)!;
  assert.equal(filed.status, 'filed');
  assert.equal(filed.ticketRef, 'issue:314');

  // Idempotence lives in the write: a second call links nothing rather than
  // overwriting the ref with a later one.
  const again = await callTool(system, agent, 'link_ticket', { ref: 'issue:999' });
  assert.equal(again.isError, true);
  assert.equal(system.store.findBugFilingByJobId(job.id)!.ticketRef, 'issue:314');
});

test('an agent on any other task has no bug to link', async () => {
  const system = build();
  await buildApp(system);
  const task = system.store.createTask({
    kind: 'code',
    title: 'Fix CI',
    prompt: 'do it',
    branch: 'issue/9',
    originRef: 'pr:142:ci',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

  // The access check is structural: there is no id to point at someone else's.
  const res = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(res.isError, true);
  assert.match(res.text, /raise a bug an operator reported|none of them/);
});
