/**
 * Conditional GETs for the GitHub client.
 *
 * The world read is O(open issues + open PRs) requests **per pulse**, and almost
 * every one of them asks for something that has not moved since the last pulse —
 * the timeline of a two-week-old issue nobody has touched is byte-identical every
 * time it is fetched. GitHub answers such a request `304 Not Modified` when it
 * carries the `If-None-Match` of the reading you already hold, and **a 304 does
 * not count against the rate limit at all**. So this is not a latency
 * optimisation with a staleness cost; it is the same reading for no budget.
 *
 * Correctness comes from GitHub rather than from a policy here. There is no TTL
 * and nothing to invalidate: a label the harness itself writes changes the
 * resource, so its ETag changes, so the very next GET is a 200 carrying the new
 * body. A cached entry can only ever be served when the server has just said it
 * is still current — which is why this is the right shape of cache for reads the
 * harness also writes to, and a time-based one would not be.
 */

/** An octokit response, narrowed to what a replay has to reproduce. */
interface CachedResponse {
  status: number;
  url: string;
  /** Kept whole: `paginate` follows `link`, and the next request re-sends `etag`. */
  headers: Record<string, unknown>;
  data: unknown;
}

/**
 * Bounded, insertion-ordered ETag store. The bound is a memory guard and nothing
 * more — an entry evicted early costs one ordinary request, never a wrong answer,
 * since the only thing lost is the chance to be told "unchanged".
 */
export class EtagCache {
  private readonly entries = new Map<string, { etag: string; response: CachedResponse }>();

  constructor(private readonly max = 512) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): { etag: string; response: CachedResponse } | undefined {
    const hit = this.entries.get(key);
    // Re-insert so the eviction below drops the least recently *used* rather than
    // the least recently written: the per-issue timeline reads are all written in
    // one burst, so write order says nothing about which is still wanted.
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, etag: string, response: CachedResponse): void {
    this.entries.delete(key);
    this.entries.set(key, { etag, response });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** The minimal octokit surface {@link installConditionalRequests} drives. */
interface HookableOctokit {
  hook: {
    wrap(
      name: 'request',
      hook: (
        // Octokit types the wrapped call as possibly-synchronous; awaiting it
        // covers both, and the response is octokit's own generated shape rather
        // than anything this file has an opinion about.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request: (options: any) => any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) => Promise<any>,
    ): void;
  };
  request: {
    endpoint: (options: unknown) => { url: string };
  };
}

/** Header lookup that does not care how the transport cased the name. */
function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Wrap `octokit`'s request path so every GET carries the ETag of the reading the
 * cache already holds, and a `304` is served from it.
 *
 * Registered **after** the retry and throttling plugins, which is what puts it
 * outermost: octokit's transport raises a 304 as a `RequestError`, and neither
 * plugin claims it (retry only acts on `status >= 400`, throttling only on
 * 403/429), so it arrives here intact and is turned back into an ordinary
 * success. Nothing downstream — `paginate` included — can tell the difference.
 *
 * Two kinds of response are deliberately not stored. A non-GET has no business in
 * a read cache, and a `string` body is the Actions **job log**, which is a whole
 * file fetched once per dispatched CI fix — caching megabytes to save a request
 * nobody repeats is the wrong trade.
 */
export function installConditionalRequests(octokit: HookableOctokit, cache: EtagCache): void {
  octokit.hook.wrap('request', async (request, options) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return request(options);

    let key: string;
    try {
      key = `GET ${octokit.request.endpoint(options).url}`;
    } catch {
      // An endpoint we cannot name is one we cannot key; pass it straight through
      // rather than guessing at a cache slot two requests could share.
      return request(options);
    }

    const cached = cache.get(key);
    const sent = cached
      ? { ...options, headers: { ...(options.headers ?? {}), 'if-none-match': cached.etag } }
      : options;

    try {
      const response = await request(sent);
      const etag = header(response?.headers, 'etag');
      if (etag !== undefined && response.status === 200 && typeof response.data !== 'string') {
        cache.set(key, etag, {
          status: response.status,
          url: response.url,
          headers: response.headers,
          data: response.data,
        });
      }
      return response;
    } catch (err) {
      if ((err as { status?: number }).status === 304 && cached) return { ...cached.response };
      throw err;
    }
  });
}
