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
import type { Job } from '../src/types.js';
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
 * up. That label is why the arm no longer spends a desk agent (issue #394): an
 * agent that forgot it left the item created, the filing shown complete, and
 * nothing ever dispatched — nothing errors and nothing is red. The harness passes
 * it to the create, so it cannot be forgotten.
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-blueprint-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: 'lubbdubb',
    dbPath: ':memory:',
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

// -- the pure half ------------------------------------------------------------

test('the ticket body is the operator’s request, verbatim', () => {
  const { title, vars } = blueprintTicketFields('Add a rate limiter to the ingest API\nit keeps falling over');
  // The title is the request's first line — no "File ticket:" prefix any more,
  // because there is no queue entry for it to be recognisable in.
  assert.equal(title, 'Add a rate limiter to the ingest API');

  const body = defaultPromptTemplates().render('blueprint-ticket-body', vars);
  assert.match(body, /Add a rate limiter to the ingest API/);
  assert.match(body, /it keeps falling over/);
  // It is a ticket body, not a prompt: nothing in it instructs anybody, and the
  // tool that used to complete the filing has no part in this arm.
  assert.doesNotMatch(body, /link_ticket|do not do the work/i);
  // No placeholder is left unfilled — a `{token}` reaching the tracker is a bug.
  assert.doesNotMatch(body, /\{\w+\}/);
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
  const body = res.json() as { ticketRef: string; job?: Job };

  // No job at all: the harness filed the item on the request, so there is nothing
  // queued and no agent spent on one API call.
  assert.equal(body.job, undefined);
  assert.equal(system.store.listJobs().length, 0);
  assert.ok(body.ticketRef.startsWith('issue:'));

  // The item itself, in the tracker, carrying the watch label the funnel keys on —
  // which is the fact that used to depend on a model remembering a sentence.
  const world = await system.connector.getState();
  const filed = world.issues.find((i) => `issue:${i.number}` === body.ticketRef)!;
  assert.equal(filed.title, 'Add a rate limiter to the ingest API');
  assert.match(filed.body, /Add a rate limiter to the ingest API/);
  assert.deepEqual(filed.labels, ['lubbdubb-watch']);
});

test('with the watch gate off, nothing is labelled — an empty tag is not a tag', async () => {
  // `labelPrefix: ''` means the harness acts on every open issue. Writing a ``
  // label would be a tag nobody asked for on every ticket the cockpit files.
  const system = build(true, { labelPrefix: '' });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: 'Build X', kind: 'code' } });
  const { ticketRef } = res.json() as { ticketRef: string };
  const world = await system.connector.getState();
  assert.deepEqual(world.issues.find((i) => `issue:${i.number}` === ticketRef)!.labels, []);
});

test('the operator’s title wins over the one derived from the request', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'make the thing faster', kind: 'code', title: 'Speed up the ingest path' },
  });
  const { ticketRef } = res.json() as { ticketRef: string };
  const world = await system.connector.getState();
  assert.equal(world.issues.find((i) => `issue:${i.number}` === ticketRef)!.title, 'Speed up the ingest path');
});

test('a code blueprint with no tracker dispatches directly, as before', async () => {
  const system = build(false); // fake issues provider — nowhere to file
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: 'Do the thing', kind: 'code' } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: Job; ticketRef?: string };
  // Unchanged fallback: a code job on the raw prompt, no ticket in between.
  assert.equal(body.job.kind, 'code');
  assert.equal(body.job.prompt, 'Do the thing');
  assert.equal(body.ticketRef, undefined);
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
  const body = res.json() as { job: Job; ticketRef?: string };
  // A desk blueprint is already off the branch-cutting path; it is dispatched as
  // asked, on its own prompt, with no ticket filed in between.
  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.prompt, 'Write me a report on X');
  assert.equal(body.ticketRef, undefined);
});
