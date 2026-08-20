import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeUpstreamIssues } from '../src/tickets/fakeUpstream.js';
import { fleetWorksUpstream, UPSTREAM_REPO } from '../src/tickets/upstream.js';
import type { Config } from '../src/config.js';
import type { FilingTargetProbe, IssueFiled } from '../src/wire.js';

/**
 * Issues #413 and #449: raising an issue **about LubbDubb** from the cockpit, and
 * the live probe that says whether it can be raised at all.
 *
 * Both routes go past the connector entirely — the report is about the tool, not
 * about the work, so it belongs on the tool's own tracker whatever repo the fleet
 * is pointed at. That is what makes the seam here `system.upstream` and not
 * `system.filing`, and it is what these tests are mostly about: the destination,
 * the byline, and the one thing that still depends on the configured tracker (the
 * watch label, which only means something where the fleet works this repo itself).
 *
 * Every case injects {@link FakeUpstreamIssues}. The real one spawns `gh` against
 * the real repository, so a test that reached it would either file an issue
 * somebody has to close or fail by whose machine ran it.
 */

/**
 * A system whose *issues provider* is really GitHub, because which repository the
 * fleet sweeps is exactly what these two routes must not follow — and a fake
 * provider cannot state one.
 *
 * The token is a placeholder and nothing ever authenticates with it: the routes
 * under test never touch the connector, and neither runs a cycle. It exists only
 * because the registry refuses to build the provider without one, which is a boot
 * check and not a call.
 */
function system(opts: { upstream?: FakeUpstreamIssues; github?: { owner: string; repo: string } } = {}): System {
  const previous = process.env.GITHUB_TOKEN;
  if (opts.github) process.env.GITHUB_TOKEN = 'placeholder-never-sent';
  try {
    const config = loadConfig({
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      labelPrefix: 'lubbdubb',
      agentMode: 'raw',
      heartbeatIntervalMs: 999_999,
      startPaused: true,
      // The issues provider only: source control stays fake, since nothing here
      // reads a branch and a second real provider would be a second boot check.
      ...(opts.github ? { integrations: { sourceControl: 'fake', issues: 'github' }, github: opts.github } : {}),
    });
    return buildSystem(config, {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
      upstream: opts.upstream ?? new FakeUpstreamIssues(),
    });
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
}

/** The dogfooding deployment: the fleet's own tracker *is* the upstream repository. */
const DOGFOOD = { owner: 'AdamAwan', repo: 'LubbDubb' };

// ---------------------------------------------------------------------------
// Which deployments can watch what they raise
// ---------------------------------------------------------------------------

test('only a fleet pointed at LubbDubb itself can watch a report raised here', () => {
  const config = (github?: { owner: string; repo: string }, issues = 'github'): Config =>
    ({ integrations: { issues }, github }) as Config;

  assert.equal(fleetWorksUpstream(config(DOGFOOD)), true, 'the dogfooding deployment sweeps this very repo');
  assert.equal(
    fleetWorksUpstream(config({ owner: 'adamawan', repo: 'lubbdubb' })),
    true,
    'GitHub does not distinguish the case, and neither may this',
  );
  assert.equal(fleetWorksUpstream(config({ owner: 'acme', repo: 'product' })), false, 'a customer’s repo, not ours');
  assert.equal(fleetWorksUpstream(config(DOGFOOD, 'azure')), false, 'the same names under another provider are not it');
  assert.equal(fleetWorksUpstream(config(undefined)), false, 'nothing configured is not a match either');
});

// ---------------------------------------------------------------------------
// GET /api/issues/filing-target
// ---------------------------------------------------------------------------

test('GET /api/issues/filing-target names LubbDubb’s own repo, not the fleet’s', async () => {
  // A fleet working somebody else's repository — the deployment issue #449 was
  // raised from, and the one where the destination must *not* follow config.
  const built = system({ github: { owner: 'acme', repo: 'product' } });
  const { app } = await buildApp(built);

  const res = await app.inject({ method: 'GET', url: '/api/issues/filing-target' });
  assert.equal(res.statusCode, 200);
  const probe = res.json() as FilingTargetProbe;
  assert.equal(probe.available, true);
  assert.equal(probe.target, UPSTREAM_REPO, 'the operator reads where it is going before typing');
  assert.equal(probe.identity, 'octocat', 'and as whom — their own gh login, not the harness’s credential');
  assert.equal(probe.reason, null);
  assert.equal(
    probe.available && probe.watchable,
    false,
    'this fleet never sweeps that repo, so the watch box is not offered',
  );

  await app.close();
  built.store.close();
});

test('the dogfooding deployment is the one that may watch what it raises', async () => {
  const built = system({ github: DOGFOOD });
  const { app } = await buildApp(built);

  const probe = (await app.inject({ method: 'GET', url: '/api/issues/filing-target' })).json() as FilingTargetProbe;
  assert.equal(probe.available && probe.watchable, true);

  await app.close();
  built.store.close();
});

test('a probe the CLI refuses is a 200 saying why, and lands in the error log', async () => {
  const built = system({
    upstream: new FakeUpstreamIssues('gh: To get started with GitHub CLI, please run: gh auth login'),
  });
  const { app } = await buildApp(built);

  const res = await app.inject({ method: 'GET', url: '/api/issues/filing-target' });
  assert.equal(res.statusCode, 200, 'a logged-out CLI is an answer to the question, not a broken endpoint');
  assert.equal((res.json() as FilingTargetProbe).available, false);
  assert.match(
    (res.json() as FilingTargetProbe).reason ?? '',
    /gh auth login/,
    'the CLI’s own words are the half that says what to do about it',
  );
  assert.match(
    built.store.listErrors(10)[0]?.message ?? '',
    /filing-target probe failed: gh: To get started/,
    'a lapsed login belongs in the Errors panel too, not only in a modal that was closed',
  );

  await app.close();
  built.store.close();
});

// ---------------------------------------------------------------------------
// POST /api/issues
// ---------------------------------------------------------------------------

test('POST /api/issues files onto LubbDubb’s tracker and answers its address', async () => {
  const upstream = new FakeUpstreamIssues();
  const built = system({ upstream, github: { owner: 'acme', repo: 'product' } });
  const { app } = await buildApp(built);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues',
    payload: { title: 'The top bar wraps at 900px', body: 'It folds onto two lines and the clock is cut off.' },
  });
  assert.equal(res.statusCode, 200);
  const filed = res.json() as IssueFiled;
  assert.equal(filed.ok, true);
  assert.match(filed.url, new RegExp(`^https://github\\.com/${UPSTREAM_REPO}/issues/\\d+$`), 'an address, not a ref');
  assert.equal(filed.url.endsWith(String(filed.number)), true, 'and the number the modal shows is that issue’s');

  assert.deepEqual(
    upstream.filed.map((f) => f.title),
    ['The top bar wraps at 900px'],
  );
  assert.deepEqual(
    upstream.filed[0]?.labels,
    [],
    'unwatched by default — the fleet is not handed a half-formed thought',
  );
  assert.deepEqual(
    built.store.getWorldBaseline()?.issues ?? [],
    [],
    'and nothing was filed into the tracker this fleet works, which is the whole of #449',
  );

  await app.close();
  built.store.close();
});

test('POST /api/issues carries the watch label only where the fleet could act on it', async () => {
  const dogfood = new FakeUpstreamIssues();
  const own = system({ upstream: dogfood, github: DOGFOOD });
  const ownApp = (await buildApp(own)).app;
  await ownApp.inject({
    method: 'POST',
    url: '/api/issues',
    payload: { title: 'Work this', body: 'Please.', watch: true },
  });
  assert.deepEqual(dogfood.filed[0]?.labels, ['lubbdubb-watch'], 'the label the pickup gate reads');
  await ownApp.close();
  own.store.close();

  // The same click on a deployment working somebody else's repo. The label is
  // dropped rather than applied: these agents never sweep that tracker, so tagging
  // it would be a promise nothing keeps.
  const elsewhere = new FakeUpstreamIssues();
  const other = system({ upstream: elsewhere, github: { owner: 'acme', repo: 'product' } });
  const otherApp = (await buildApp(other)).app;
  await otherApp.inject({
    method: 'POST',
    url: '/api/issues',
    payload: { title: 'Work this', body: 'Please.', watch: true },
  });
  assert.deepEqual(elsewhere.filed[0]?.labels, []);
  await otherApp.close();
  other.store.close();
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

test('a CLI that refuses the create is a 502 carrying its own words', async () => {
  const built = system({ upstream: new FakeUpstreamIssues('HTTP 403: Resource not accessible') });
  const { app } = await buildApp(built);

  const res = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: 'A title', body: 'A body' } });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: `${UPSTREAM_REPO} refused the issue: HTTP 403: Resource not accessible` });
  assert.match(
    built.store.listErrors(10)[0]?.message ?? '',
    /filing an issue from the cockpit failed: HTTP 403/,
    'and the modal is not the only place it is recorded',
  );

  await app.close();
  built.store.close();
});
