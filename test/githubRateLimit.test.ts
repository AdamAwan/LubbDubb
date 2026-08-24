import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EtagCache, installConditionalRequests } from '../src/integrations/github/etagCache.js';
import { waitOutRateLimit } from '../src/integrations/github/octokitGitHubApi.js';
import { Store } from '../src/store/store.js';
import { buildIntegrations } from '../src/integrations/registry.js';
import { loadConfig } from '../src/config.js';

const FIXED = () => '2026-01-01T00:00:00.000Z';

/** One recorded request, so a test can assert what actually went over the wire. */
interface Sent {
  method: string;
  headers: Record<string, unknown>;
}

/**
 * The narrow slice of octokit {@link installConditionalRequests} drives, scripted.
 *
 * `respond` stands in for GitHub: it is handed the request the hook composed and
 * answers with a response or throws, exactly as octokit's transport does — a `304`
 * arrives as a thrown error carrying that status, which is the shape the hook has
 * to recognise.
 */
function fakeOctokit(respond: (sent: Sent) => unknown): {
  octokit: Parameters<typeof installConditionalRequests>[0];
  request: (options: Record<string, unknown>) => Promise<unknown>;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  let wrapped: ((request: (o: unknown) => unknown, o: unknown) => Promise<unknown>) | null = null;
  const inner = async (options: Record<string, unknown>): Promise<unknown> => {
    const record = {
      method: String(options.method ?? 'GET'),
      headers: (options.headers ?? {}) as Record<string, unknown>,
    };
    sent.push(record);
    return respond(record);
  };
  const octokit = {
    hook: {
      wrap: (_name: 'request', hook: (request: (o: unknown) => unknown, o: unknown) => Promise<unknown>) => {
        wrapped = hook;
      },
    },
    request: { endpoint: (options: unknown) => ({ url: String((options as { url?: string }).url ?? '/x') }) },
  };
  return {
    octokit,
    sent,
    request: async (options) => {
      assert.ok(wrapped, 'the hook was never installed');
      return wrapped(inner as (o: unknown) => unknown, options);
    },
  };
}

/** What octokit's transport raises for a `304`: a plain error carrying the status. */
function notModified(): Error {
  return Object.assign(new Error('Not modified'), { status: 304 });
}

test('a GET is re-sent with the etag it was answered with, and a 304 replays the cached body', async () => {
  let answer: () => unknown = () => ({
    status: 200,
    url: '/repos/o/r/issues/1/timeline',
    headers: { etag: 'W/"abc"', link: '<next>; rel="next"' },
    data: [{ event: 'labeled' }],
  });
  const gh = fakeOctokit(() => answer());
  installConditionalRequests(gh.octokit, new EtagCache());

  const first = await gh.request({ method: 'GET', url: '/repos/o/r/issues/1/timeline' });
  assert.deepEqual((first as { data: unknown }).data, [{ event: 'labeled' }]);
  // Nothing was cached to send yet, so nothing conditioned the first read.
  assert.equal(gh.sent[0]?.headers['if-none-match'], undefined);

  answer = () => {
    throw notModified();
  };
  const second = await gh.request({ method: 'GET', url: '/repos/o/r/issues/1/timeline' });
  assert.equal(gh.sent[1]?.headers['if-none-match'], 'W/"abc"');
  // The replay is indistinguishable from the original success — including the
  // `link` header, which is what lets `paginate` walk on past a cached page.
  assert.equal((second as { status: number }).status, 200);
  assert.deepEqual((second as { data: unknown }).data, [{ event: 'labeled' }]);
  assert.equal((second as { headers: Record<string, unknown> }).headers.link, '<next>; rel="next"');
});

test('a 304 with nothing cached for it is re-thrown rather than answered', async () => {
  const gh = fakeOctokit(() => {
    throw notModified();
  });
  installConditionalRequests(gh.octokit, new EtagCache());
  await assert.rejects(() => gh.request({ method: 'GET', url: '/repos/o/r/pulls' }), /Not modified/);
});

test('a write is neither conditioned nor cached', async () => {
  const gh = fakeOctokit(() => ({
    status: 200,
    url: '/repos/o/r/issues/1/labels',
    headers: { etag: 'W/"z"' },
    data: {},
  }));
  installConditionalRequests(gh.octokit, new EtagCache());
  await gh.request({ method: 'POST', url: '/repos/o/r/issues/1/labels' });
  await gh.request({ method: 'POST', url: '/repos/o/r/issues/1/labels' });
  assert.equal(gh.sent.length, 2);
  for (const s of gh.sent) assert.equal(s.headers['if-none-match'], undefined);
});

test('a job log is not cached — a whole file, fetched once per dispatched fix', async () => {
  const gh = fakeOctokit(() => ({ status: 200, url: '/logs', headers: { etag: 'W/"log"' }, data: 'a'.repeat(1000) }));
  const cache = new EtagCache();
  installConditionalRequests(gh.octokit, cache);
  await gh.request({ method: 'GET', url: '/logs' });
  assert.equal(cache.size, 0);
});

test('the etag store is bounded, dropping the least recently used', () => {
  const cache = new EtagCache(2);
  const body = (data: string) => ({ status: 200, url: '/x', headers: {}, data });
  cache.set('a', '1', body('a'));
  cache.set('b', '2', body('b'));
  // Touching 'a' makes 'b' the least recently used, so the third entry evicts it.
  assert.ok(cache.get('a'));
  cache.set('c', '3', body('c'));
  assert.equal(cache.size, 2);
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('c'));
});

test('a primary rate limit is waited out only while the wait is a blip', () => {
  // The hourly window resetting — the shape of the limit the fleet actually hits.
  // Waiting parks every request in the fan-out and buys nothing `lastGood` does not.
  assert.equal(waitOutRateLimit(625, 0), false);
  assert.equal(waitOutRateLimit(61, 0), false);
  // A window about to turn over anyway: cheaper to absorb than to lose the pulse.
  assert.equal(waitOutRateLimit(5, 0), true);
  assert.equal(waitOutRateLimit(60, 2), true);
  // ...and still bounded by the retry budget.
  assert.equal(waitOutRateLimit(5, 3), false);
});

test('both github capabilities share one client', () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_test';
  const store = new Store(':memory:');
  try {
    const config = loadConfig({ github: { owner: 'o', repo: 'r' } });
    const integrations = buildIntegrations(
      { sourceControl: 'github', issues: 'github', pool: 'fake' },
      { store, config, now: FIXED },
    );
    // Two clients would be two ETag caches and two views of one hourly budget,
    // neither able to tell the other it had run out. Read structurally because
    // that is the only place the sharing is observable.
    const apis = integrations.map((i) => (i as unknown as { opts: { api: unknown } }).opts.api);
    assert.equal(apis.length, 2);
    assert.equal(apis[0], apis[1]);
  } finally {
    store.close();
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});
