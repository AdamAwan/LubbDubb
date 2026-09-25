import type { AzureAuth } from './azureAuth.js';
import { AzureEtagCache } from './conditionalRequests.js';

// → docs/spec/15-integrations.md

const API_VERSION = '7.1';

const MAX_RETRIES = 2;
const PAGE_SIZE = 100;
const RETRY_BACKOFF_MS = 300;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSignInHtml(contentType: string | null, body: string): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return /^\s*<(?:!doctype|html)\b/i.test(body);
}

export function withApiVersion(
  url: string,
  params: Record<string, string> = {},
  apiVersion: string = API_VERSION,
): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('api-version', apiVersion);
  return u.toString();
}

interface Call {
  url: string;
  init: RequestInit;
  method: string;
  conditional: boolean;
  cached: { etag: string; body: string } | undefined;
}

export class AzureTransport {
  private readonly etags = new AzureEtagCache();

  constructor(
    private readonly auth: AzureAuth,
    private readonly fetchImpl: typeof fetch,
    private readonly log: (message: string) => void,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async pagedPulls<T extends { pullRequestId: number }>(
    url: string,
    params: Record<string, string>,
    opts: { conditional?: boolean } = {},
  ): Promise<T[]> {
    const out = new Map<number, T>();
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const data = await this.request<{ value: T[] }>(
        withApiVersion(url, { ...params, $top: String(PAGE_SIZE), $skip: String(skip) }),
        {},
        opts,
      );
      for (const pull of data.value) out.set(pull.pullRequestId, pull);
      if (data.value.length < PAGE_SIZE) return [...out.values()];
    }
  }

  async request<T>(url: string, init: RequestInit = {}, opts: { conditional?: boolean } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const conditional = opts.conditional !== false;
    const cached = method === 'GET' && conditional ? this.etags.get(url) : undefined;
    const call: Call = { url, init, method, conditional, cached };
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        this.auth.forceRefresh?.();
        await this.sleep(RETRY_BACKOFF_MS * attempt);
      }
      const outcome = await this.attempt<T>(call);
      if ('value' in outcome) return outcome.value;
      lastError = outcome.retry;
    }

    const exhausted = lastError ?? new Error(`Azure DevOps ${method} ${url}: failed after ${MAX_RETRIES} retries`);
    this.log(`Azure DevOps ${method} ${url}: failed after ${MAX_RETRIES + 1} attempts — ${exhausted.message}`);
    throw exhausted;
  }

  private async attempt<T>(call: Call): Promise<{ value: T } | { retry: Error }> {
    const { url, init, method, cached } = call;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers: await this.headers(init, cached) });
    } catch (err) {
      return { retry: new Error(`Azure DevOps ${method} ${url}: network error: ${(err as Error).message}`) };
    }

    const body = await res.text().catch(() => '');
    const contentType = res.headers.get('content-type');

    if (res.status === 304 && cached) return { value: JSON.parse(cached.body) as T };

    if (!res.ok) {
      const error = new Error(
        `Azure DevOps ${method} ${url} -> ${res.status} ${res.statusText} ` +
          `(${contentType ?? 'no content-type'}): ${body.slice(0, 300)}`,
      );
      if (res.status === 429 || res.status >= 500) return { retry: error };
      throw error;
    }

    if (body.trim() === '') return { value: undefined as T };

    if (isSignInHtml(contentType, body))
      return {
        retry: new Error(
          `Azure DevOps ${method} ${url} -> ${res.status} returned an HTML sign-in page instead of JSON — ` +
            `the credential was rejected. Check \`az login\` (or AZURE_DEVOPS_PAT) and the organization name. ` +
            `Body: ${body.slice(0, 200)}`,
        ),
      };

    return { value: this.parse<T>(call, res, body, contentType) };
  }

  private parse<T>(call: Call, res: Response, body: string, contentType: string | null): T {
    const { url, method, conditional } = call;
    try {
      const parsed = JSON.parse(body) as T;
      const etag = res.headers.get('etag');
      if (method === 'GET' && conditional && res.status === 200 && etag) this.etags.set(url, etag, body);
      return parsed;
    } catch {
      throw new Error(
        `Azure DevOps ${method} ${url} -> ${res.status} returned invalid JSON ` +
          `(${contentType ?? 'no content-type'}): ${body.slice(0, 200)}`,
      );
    }
  }

  private async headers(init: RequestInit, cached: Call['cached']): Promise<HeadersInit> {
    return {
      Authorization: await this.auth.header(),
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
      ...init.headers,
    };
  }
}
