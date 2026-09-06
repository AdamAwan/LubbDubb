// → docs/spec/15-integrations.md

interface CachedResponse {
  status: number;
  url: string;
  headers: Record<string, unknown>;
  data: unknown;
}

export class EtagCache {
  private readonly entries = new Map<string, { etag: string; response: CachedResponse }>();

  constructor(private readonly max = 512) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): { etag: string; response: CachedResponse } | undefined {
    const hit = this.entries.get(key);
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

interface HookableOctokit {
  hook: {
    wrap(
      name: 'request',
      hook: (
        // TECHDEBT: Octokit types the wrapped call as possibly-synchronous; awaiting it
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

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

export function installConditionalRequests(octokit: HookableOctokit, cache: EtagCache): void {
  octokit.hook.wrap('request', async (request, options) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return request(options);

    let key: string;
    try {
      key = `GET ${octokit.request.endpoint(options).url}`;
    } catch {
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
