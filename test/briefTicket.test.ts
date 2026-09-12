import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { briefTicketFields } from '../src/briefTicket.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Job } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-brief-'));
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

test('the ticket body is the operator’s request, verbatim', () => {
  const { title, vars } = briefTicketFields('Add a rate limiter to the ingest API\nit keeps falling over');
  assert.equal(title, 'Add a rate limiter to the ingest API');

  const body = defaultPromptTemplates().render('brief-ticket-body', vars);
  assert.match(body, /Add a rate limiter to the ingest API/);
  assert.match(body, /it keeps falling over/);
  assert.doesNotMatch(body, /link_ticket|do not do the work/i);
  assert.doesNotMatch(body, /\{\w+\}/);
});

test('a code brief with a tracker is filed as a watched ticket, not dispatched', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'Add a rate limiter to the ingest API', kind: 'code' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ticketRef: string; job?: Job };

  assert.equal(body.job, undefined);
  assert.equal(system.store.jobs.listJobs().length, 0);
  assert.ok(body.ticketRef.startsWith('issue:'));

  const world = await system.connector.getState();
  const filed = world.issues.find((i) => `issue:${i.number}` === body.ticketRef)!;
  assert.equal(filed.title, 'Add a rate limiter to the ingest API');
  assert.match(filed.body, /Add a rate limiter to the ingest API/);
  assert.deepEqual(filed.labels, ['lubbdubb-watch']);
});

test('with the watch gate off, nothing is labelled — an empty tag is not a tag', async () => {
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

test('a code brief with no tracker dispatches directly, as before', async () => {
  const system = build(false);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: 'Do the thing', kind: 'code' } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: Job; ticketRef?: string };
  assert.equal(body.job.kind, 'code');
  assert.equal(body.job.prompt, 'Do the thing');
  assert.equal(body.ticketRef, undefined);
});

test('a desk brief dispatches directly even when a tracker is configured', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'Write me a report on X', kind: 'desk' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { job: Job; ticketRef?: string };
  assert.equal(body.job.kind, 'desk');
  assert.equal(body.job.prompt, 'Write me a report on X');
  assert.equal(body.ticketRef, undefined);
});
