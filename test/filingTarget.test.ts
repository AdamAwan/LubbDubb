import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { CompositeConnector } from '../src/integrations/compositeConnector.js';
import { ticketFiler } from '../src/tickets/filing.js';
import { FakeConnector } from '../src/connector/fakeConnector.js';
import { Store } from '../src/store/store.js';
import type { Capability, Integration, IssueCreateCapable, WorldSlice } from '../src/integrations/integration.js';
import type { FilingTarget, IssueCreateInput, SendResult } from '../src/sink/actionSink.js';
import type { FilingTargetProbe, IssueFiled } from '../src/wire.js';

/**
 * Issue #413: raising an issue from the cockpit, and the live probe that says
 * whether it can be raised at all.
 *
 * The two halves are tested at different seams on purpose. Whether a provider can
 * name its target is the provider's own business and belongs beside its scripted
 * `*Api` (`githubIntegration.test.ts`, `azureDevOpsIntegration.test.ts`); what the
 * *route* does with a target that will not answer is the thing that has arms to
 * get wrong, and that is here.
 */

function system(): System {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

/**
 * An issues provider whose probe fails — a revoked token, in the only shape the
 * harness ever sees it. Swapped in over the built system's connector rather than
 * configured, because the fault being modelled is a live call failing and no
 * amount of config produces one.
 */
function refusing(message: string): Integration & IssueCreateCapable {
  return {
    id: 'issues:refusing',
    capability: 'issues' satisfies Capability,
    async snapshot(): Promise<WorldSlice> {
      return { issues: [] };
    },
    async createIssue(_input: IssueCreateInput): Promise<SendResult> {
      throw new Error(message);
    },
    async describeFilingTarget(): Promise<FilingTarget> {
      throw new Error(message);
    },
  };
}

/** An issues provider that reads and cannot file — the read-only tracker. */
function readOnly(): Integration {
  return {
    id: 'issues:read-only',
    capability: 'issues' satisfies Capability,
    async snapshot(): Promise<WorldSlice> {
      return { issues: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// The capability and the composite
// ---------------------------------------------------------------------------

test('the fake tracker names itself and claims no identity', async () => {
  const store = new Store(':memory:');
  const connector = new FakeConnector(store);
  assert.deepEqual(await connector.describeFilingTarget(), { target: 'the fake tracker', identity: null });
  store.close();
});

test('the composite answers the probe only while something can create issues', async () => {
  const none = new CompositeConnector([readOnly()]);
  assert.equal(none.canCreateIssues(), false, 'a provider that only reads cannot file');
  await assert.rejects(none.describeFilingTarget(), /no issues provider is IssueCreateCapable/);

  const some = new CompositeConnector([refusing('Bad credentials')]);
  assert.equal(some.canCreateIssues(), true, 'the capability is what is asked, not whether the call succeeds');
});

// ---------------------------------------------------------------------------
// GET /api/issues/filing-target
// ---------------------------------------------------------------------------

test('GET /api/issues/filing-target answers from a live provider call', async () => {
  const built = system();
  const { app } = await buildApp(built);

  const res = await app.inject({ method: 'GET', url: '/api/issues/filing-target' });
  assert.equal(res.statusCode, 200);
  const probe = res.json() as FilingTargetProbe;
  assert.equal(probe.available, true);
  assert.equal(probe.target, 'the fake tracker', 'the operator reads where it is going before typing');
  assert.equal(probe.identity, null, 'nobody is authenticated against a fake, and it says so');
  assert.equal(probe.reason, null);

  await app.close();
  built.store.close();
});

test('a probe the provider refuses is a 200 saying why, and lands in the error log', async () => {
  const built = system();
  const { app } = await buildApp({ ...built, connector: new CompositeConnector([refusing('Bad credentials')]) });

  const res = await app.inject({ method: 'GET', url: '/api/issues/filing-target' });
  assert.equal(res.statusCode, 200, 'a dead token is an answer to the question, not a broken endpoint');
  assert.deepEqual(res.json(), {
    available: false,
    target: null,
    identity: null,
    reason: 'Bad credentials',
  });
  assert.match(
    built.store.listErrors(10)[0]?.message ?? '',
    /filing-target probe failed: Bad credentials/,
    'an expired filing credential belongs in the Errors panel too, not only in a modal that was closed',
  );

  await app.close();
  built.store.close();
});

test('a provider that cannot file at all is reported without an error entry', async () => {
  const built = system();
  const { app } = await buildApp({ ...built, connector: new CompositeConnector([readOnly()]) });

  const probe = (await app.inject({ method: 'GET', url: '/api/issues/filing-target' })).json() as FilingTargetProbe;
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? '', /no issue tracker is configured/);
  assert.deepEqual(built.store.listErrors(10), [], 'a deployment shape is not a fault');

  await app.close();
  built.store.close();
});

// ---------------------------------------------------------------------------
// POST /api/issues
// ---------------------------------------------------------------------------

test('POST /api/issues files the operator’s own issue and answers its ref', async () => {
  const built = system();
  const { app } = await buildApp(built);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues',
    payload: { title: 'The top bar wraps at 900px', body: 'It folds onto two lines and the clock is cut off.' },
  });
  assert.equal(res.statusCode, 200);
  const filed = res.json() as IssueFiled;
  assert.equal(filed.ok, true);
  assert.match(filed.ref, /^issue:\d+$/, 'the harness’s own vocabulary, never a provider id');
  assert.equal(filed.url, null, 'the fake world has no web address to link to');

  const number = Number(filed.ref.slice('issue:'.length));
  const created = built.store.getWorldBaseline()?.issues.find((i) => i.number === number);
  assert.equal(created?.title, 'The top bar wraps at 900px', 'and it is in the world the cockpit draws, now');
  assert.deepEqual(created?.labels, [], 'unwatched by default — the fleet is not handed a half-formed thought');

  await app.close();
  built.store.close();
});

test('POST /api/issues carries the watch label only when it is asked for', async () => {
  const built = system();
  const { app } = await buildApp(built);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues',
    payload: { title: 'Work this one', body: 'Please pick it up.', watch: true },
  });
  const { ref } = res.json() as IssueFiled;
  const number = Number(ref.slice('issue:'.length));
  const created = built.store.getWorldBaseline()?.issues.find((i) => i.number === number);
  assert.deepEqual(
    created?.labels,
    ['lubbdubb-watch'],
    'the label the pickup gate reads, chosen rather than inherited',
  );

  await app.close();
  built.store.close();
});

test('POST /api/issues refuses a body it cannot file from', async () => {
  const built = system();
  const { app } = await buildApp(built);

  const noTitle = await app.inject({ method: 'POST', url: '/api/issues', payload: { body: 'something' } });
  assert.equal(noTitle.statusCode, 400);
  assert.deepEqual(noTitle.json(), { error: 'title is required' });

  const blankBody = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: 'A title', body: '  ' } });
  assert.equal(blankBody.statusCode, 400);
  assert.deepEqual(blankBody.json(), { error: 'body is required — say what should happen' });

  const badWatch = await app.inject({
    method: 'POST',
    url: '/api/issues',
    payload: { title: 'A title', body: 'A body', watch: 'yes' },
  });
  assert.equal(badWatch.statusCode, 400);
  assert.deepEqual(badWatch.json(), { error: 'watch must be a boolean' });

  await app.close();
  built.store.close();
});

test('POST /api/issues refuses in prose when nothing can create an issue', async () => {
  const built = system();
  const { app } = await buildApp({ ...built, connector: new CompositeConnector([readOnly()]) });

  const res = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: 'A title', body: 'A body' } });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no issue tracker is configured to file into/);

  await app.close();
  built.store.close();
});

test('a tracker that refuses the create is a 502 carrying its own words', async () => {
  const built = system();
  const connector = new CompositeConnector([refusing('403 Forbidden')]);
  // The filer is bound to a connector at composition time, so a test that swaps the
  // connector rebinds it — otherwise the route would file through the fake world it
  // was built with and the refusal being modelled would never be reached.
  const { app } = await buildApp({ ...built, connector, filing: ticketFiler(built.config, connector) });

  const res = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: 'A title', body: 'A body' } });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: 'the tracker refused the issue: 403 Forbidden' });
  assert.match(built.store.listErrors(10)[0]?.message ?? '', /filing an issue from the cockpit failed: 403 Forbidden/);

  await app.close();
  built.store.close();
});
