import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeMethod } from '../../sink/actionSink.js';
import type {
  AzCommentRef,
  AzMergeResult,
  AzPull,
  AzStatus,
  AzThread,
  AzWorkItem,
  AzureDevOpsApi,
} from './azureDevOpsApi.js';
import { mergeStrategyFor, stripRef } from './sourceControl.js';

const execFileAsync = promisify(execFile);

/** The Azure DevOps resource GUID the `az` CLI mints access tokens against. */
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

const API_VERSION = '7.1';

/** connectionData is a preview-only resource: 7.1 is rejected without the -preview suffix. */
const CONNECTION_DATA_API_VERSION = '7.1-preview.1';

/**
 * How the harness authenticates to Azure DevOps. Two implementations ship, chosen
 * by {@link resolveAzureAuth}: a Personal Access Token (Basic auth) or, when no PAT
 * is set, an access token from the logged-in `az` CLI (Bearer). Injectable so the
 * REST client stays testable and the `az` spawn is isolated.
 */
export interface AzureAuth {
  /** The `Authorization` header value to send with each request. */
  header(): Promise<string>;
}

/** Basic auth with a Personal Access Token — the empty username is the ADO convention. */
export class PatAuth implements AzureAuth {
  constructor(private readonly pat: string) {}
  async header(): Promise<string> {
    return `Basic ${Buffer.from(`:${this.pat}`).toString('base64')}`;
  }
}

/**
 * Bearer auth from the logged-in `az` CLI (`az account get-access-token`). The
 * token is cached and refreshed on a fixed window rather than parsing Azure's
 * ambiguous local-time `expiresOn` — ADO tokens live well past this, so a
 * conservative refresh is safe and avoids a fragile date parse.
 */
export class AzCliAuth implements AzureAuth {
  private cached: { token: string; fetchedAtMs: number } | null = null;
  /** Refresh well inside the token's real lifetime (typically 60–90 min). */
  private static readonly TTL_MS = 45 * 60 * 1000;

  constructor(private readonly fetchToken: () => Promise<string> = defaultAzToken) {}

  async header(): Promise<string> {
    const now = Date.now();
    if (!this.cached || now - this.cached.fetchedAtMs >= AzCliAuth.TTL_MS) {
      this.cached = { token: await this.fetchToken(), fetchedAtMs: now };
    }
    return `Bearer ${this.cached.token}`;
  }
}

/** Spawn the `az` CLI for an Azure DevOps access token. Throws a clear error if `az` isn't logged in. */
async function defaultAzToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '--output', 'tsv'],
      // On Windows `az` is `az.cmd`; execFile won't resolve the extension without a
      // shell, so it ENOENTs. All args here are hardcoded constants — no injection risk.
      { shell: true },
    );
    const token = stdout.trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch (err) {
    throw new Error(
      `Could not get an Azure DevOps token from the az CLI (${(err as Error).message}). ` +
        'Run `az login`, or set AZURE_DEVOPS_PAT to a Personal Access Token.',
    );
  }
}

/**
 * Pick the auth strategy: a Personal Access Token (`AZURE_DEVOPS_PAT`) if set,
 * otherwise the logged-in `az` CLI. The PAT is read from the environment only —
 * never from config — so a secret never lands in a committed file (mirroring
 * `GITHUB_TOKEN`).
 */
export function resolveAzureAuth(): AzureAuth {
  const pat = process.env.AZURE_DEVOPS_PAT;
  return pat ? new PatAuth(pat) : new AzCliAuth();
}

// ---------------------------------------------------------------------------
// Minimal shapes of the Azure DevOps JSON we read. Only the fields we consume.
// ---------------------------------------------------------------------------

interface RawPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId?: string };
  createdBy?: { uniqueName?: string };
  reviewers?: Array<{ vote?: number }>;
}

interface RawThread {
  id: number;
  status?: string | null;
  comments?: Array<{
    id: number;
    author?: { uniqueName?: string };
    content?: string;
    parentCommentId?: number | null;
    commentType?: string;
  }>;
}

interface RawWorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string }>;
}

/**
 * The real {@link AzureDevOpsApi}: one bound `organization`/`project`/`repository`,
 * all HTTP behind `fetch`, mapping Azure's responses down to the minimal `Az*`
 * shapes the integrations consume. All Azure DevOps HTTP (and auth) lives here —
 * nothing else in the repo touches the network — so the integrations stay
 * network-free and unit-testable.
 */
export class RestAzureDevOpsApi implements AzureDevOpsApi {
  private viewer: string | null = null;

  constructor(
    private readonly organization: string,
    private readonly project: string,
    private readonly repository: string,
    private readonly auth: AzureAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static create(
    cfg: { organization: string; project: string; repository: string },
    auth: AzureAuth,
  ): RestAzureDevOpsApi {
    return new RestAzureDevOpsApi(cfg.organization, cfg.project, cfg.repository, auth);
  }

  private get orgUrl(): string {
    return `https://dev.azure.com/${encodeURIComponent(this.organization)}`;
  }
  private get projectUrl(): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}`;
  }
  private get repoUrl(): string {
    return `${this.projectUrl}/_apis/git/repositories/${encodeURIComponent(this.repository)}`;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: await this.auth.header(),
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Azure DevOps ${init.method ?? 'GET'} ${url} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  private withApiVersion(url: string, params: Record<string, string> = {}, apiVersion: string = API_VERSION): string {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('api-version', apiVersion);
    return u.toString();
  }

  async viewerUniqueName(): Promise<string> {
    // Stable for the auth lifetime, so fetch it once.
    if (this.viewer === null) {
      const data = await this.request<{
        authenticatedUser?: { properties?: { Account?: { $value?: string } }; providerDisplayName?: string };
      }>(this.withApiVersion(`${this.orgUrl}/_apis/connectionData`, {}, CONNECTION_DATA_API_VERSION));
      const user = data.authenticatedUser;
      this.viewer = user?.properties?.Account?.$value ?? user?.providerDisplayName ?? '';
    }
    return this.viewer;
  }

  async listActivePullRequests(): Promise<AzPull[]> {
    const data = await this.request<{ value: RawPull[] }>(
      this.withApiVersion(`${this.repoUrl}/pullrequests`, { 'searchCriteria.status': 'active', $top: '100' }),
    );
    return data.value.map((p) => ({
      pullRequestId: p.pullRequestId,
      title: p.title,
      branch: stripRef(p.sourceRefName),
      baseBranch: stripRef(p.targetRefName),
      lastMergeSourceCommit: p.lastMergeSourceCommit?.commitId ?? '',
      authorUniqueName: p.createdBy?.uniqueName ?? '',
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${p.pullRequestId}`,
      isDraft: p.isDraft ?? false,
      mergeStatus: p.mergeStatus ?? 'notSet',
      reviewerVotes: (p.reviewers ?? []).map((r) => r.vote ?? 0),
    }));
  }

  async listPullThreads(pullRequestId: number): Promise<AzThread[]> {
    const data = await this.request<{ value: RawThread[] }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
    );
    return data.value.map((t) => ({
      id: t.id,
      status: t.status ?? null,
      comments: (t.comments ?? []).map((c) => ({
        id: c.id,
        authorUniqueName: c.author?.uniqueName ?? '',
        content: c.content ?? '',
        parentCommentId: c.parentCommentId ?? null,
        commentType: c.commentType ?? 'text',
      })),
    }));
  }

  async listPullStatuses(pullRequestId: number): Promise<AzStatus[]> {
    const data = await this.request<{ value: Array<{ state?: string | null }> }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/statuses`),
    );
    return data.value.map((s) => ({ state: s.state ?? null }));
  }

  async listPullLabels(pullRequestId: number): Promise<string[]> {
    const data = await this.request<{ value: Array<{ name?: string }> }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/labels`),
    );
    return data.value.map((l) => l.name ?? '').filter((name) => name !== '');
  }

  async listOpenWorkItems(tag?: string): Promise<AzWorkItem[]> {
    // Two-step: WIQL returns the matching ids, then a batch read hydrates fields
    // and relations. WIQL can't return fields directly, so the batch is required.
    const wiql = buildOpenWorkItemQuery(tag);
    const query = await this.request<{ workItems?: Array<{ id: number }> }>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/wiql`),
      { method: 'POST', body: JSON.stringify({ query: wiql }) },
    );
    const ids = (query.workItems ?? []).map((w) => w.id);
    if (ids.length === 0) return [];

    // Batch reads are capped at 200 ids by Azure; chunk to stay under it.
    const items: AzWorkItem[] = [];
    for (const chunk of chunkIds(ids, 200)) {
      const batch = await this.request<{ value: RawWorkItem[] }>(
        this.withApiVersion(`${this.orgUrl}/_apis/wit/workitemsbatch`),
        { method: 'POST', body: JSON.stringify({ ids: chunk, $expand: 'Relations' }) },
      );
      for (const w of batch.value) items.push(this.mapWorkItem(w));
    }
    return items;
  }

  private mapWorkItem(w: RawWorkItem): AzWorkItem {
    const fields = w.fields ?? {};
    const rawTags = String(fields['System.Tags'] ?? '');
    return {
      id: w.id,
      title: String(fields['System.Title'] ?? ''),
      body: String(fields['System.Description'] ?? ''),
      state: String(fields['System.State'] ?? ''),
      tags: rawTags
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      relationUrls: (w.relations ?? [])
        .filter((r) => r.rel === 'ArtifactLink' && typeof r.url === 'string')
        .map((r) => r.url as string),
      url: `${this.projectUrl}/_workitems/edit/${w.id}`,
    };
  }

  async createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef> {
    await this.request(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}/comments`),
      { method: 'POST', body: JSON.stringify({ content, parentCommentId, commentType: 'text' }) },
    );
    return { url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}` };
  }

  async createThread(pullRequestId: number, content: string): Promise<AzCommentRef> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`), {
      method: 'POST',
      body: JSON.stringify({ comments: [{ content, commentType: 'text' }], status: 'active' }),
    });
    return { url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}` };
  }

  async completePullRequest(
    pullRequestId: number,
    lastMergeSourceCommit: string,
    method: MergeMethod,
  ): Promise<AzMergeResult> {
    const data = await this.request<{ status?: string }>(
      this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`),
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'completed',
          lastMergeSourceCommit: { commitId: lastMergeSourceCommit },
          completionOptions: { mergeStrategy: mergeStrategyFor(method), deleteSourceBranch: false },
        }),
      },
    );
    return { status: data.status ?? 'unknown' };
  }

  async setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void> {
    const labelsUrl = `${this.repoUrl}/pullRequests/${pullRequestId}/labels`;
    if (present) {
      // POST is idempotent-ish: re-adding an existing label just returns it.
      await this.request(this.withApiVersion(labelsUrl), { method: 'POST', body: JSON.stringify({ name: label }) });
    } else {
      // DELETE by label name; a 404 (label not present) is a no-op for our purposes.
      try {
        await this.request(this.withApiVersion(`${labelsUrl}/${encodeURIComponent(label)}`), { method: 'DELETE' });
      } catch (err) {
        if (!/-> 404\b/.test((err as Error).message)) throw err;
      }
    }
  }
}

/** WIQL selecting open work items in the bound project, optionally narrowed to a tag. */
export function buildOpenWorkItemQuery(tag?: string): string {
  const clauses = [
    '[System.TeamProject] = @project',
    "[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')",
  ];
  // Tags are matched with CONTAINS; a single-quote in a tag would break the query,
  // so escape it the SQL way (double the quote).
  if (tag) clauses.push(`[System.Tags] CONTAINS '${tag.replace(/'/g, "''")}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.Id] ASC`;
}

function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}
