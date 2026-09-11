import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeMethod } from '../../sink/actionSink.js';
import { withinClosedWindow } from '../closedWindow.js';
import type { AreaPathTree } from '../../intake/placement.js';
import type {
  AzClosedPull,
  AzCommentRef,
  AzMergeResult,
  AzPolicyEvaluation,
  AzPolicyRequeue,
  AzPull,
  AzThread,
  AzTimelineRecord,
  AzWorkItem,
  AzWorkItemCommentRef,
  AzWorkItemUpdate,
  AzureDevOpsApi,
} from './azureDevOpsApi.js';
import { mergeStrategyFor, stripRef } from './sourceControl.js';
import { parseTags } from './workItems.js';
import { composeWorkItemBody } from './workItemBody.js';
import { AzureEtagCache } from './conditionalRequests.js';

// → docs/spec/15-integrations.md

const execFileAsync = promisify(execFile);

const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

const API_VERSION = '7.1';

const CONNECTION_DATA_API_VERSION = '7.1-preview.1';

const POLICY_API_VERSION = '7.1-preview.1';

const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

const WORK_ITEM_COMMENTS_API_VERSION = '7.1-preview.4';

export interface AzureAuth {
  header(): Promise<string>;
  forceRefresh?(): void;
}

class PatAuth implements AzureAuth {
  constructor(private readonly pat: string) {}
  async header(): Promise<string> {
    return `Basic ${Buffer.from(`:${this.pat}`).toString('base64')}`;
  }
}

class AzCliAuth implements AzureAuth {
  private cached: { token: string; fetchedAtMs: number } | null = null;
  private static readonly TTL_MS = 45 * 60 * 1000;

  constructor(private readonly fetchToken: () => Promise<string> = azCliAccessToken) {}

  async header(): Promise<string> {
    const now = Date.now();
    if (!this.cached || now - this.cached.fetchedAtMs >= AzCliAuth.TTL_MS) {
      this.cached = { token: await this.fetchToken(), fetchedAtMs: now };
    }
    return `Bearer ${this.cached.token}`;
  }

  forceRefresh(): void {
    this.cached = null;
  }
}

/**
 * Spawn the `az` CLI for an Azure DevOps access token. Throws a clear error if `az` isn't logged in.
 *
 * Exported so Setup's credential probe asks the *same* question the auth path asks
 * (`src/setup/probes.ts`) — a second spawn written to look equivalent drifts.
 * @public called by `RealSetupProbes.azSignedIn`.
 */
export async function azCliAccessToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '--output', 'tsv'],
      // TECHDEBT: On Windows `az` is `az.cmd`; execFile won't resolve the extension without a
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

export function resolveAzureAuth(): AzureAuth {
  const pat = process.env.AZURE_DEVOPS_PAT;
  return pat ? new PatAuth(pat) : new AzCliAuth();
}

interface RawPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId?: string };
  createdBy?: { uniqueName?: string; displayName?: string };
  reviewers?: Array<{ vote?: number; uniqueName?: string; isRequired?: boolean; isContainer?: boolean }>;
}

interface RawClosedPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  status?: string;
  closedDate?: string;
  createdBy?: { uniqueName?: string };
  lastMergeCommit?: { commitId?: string };
}

interface RawThread {
  id: number;
  status?: string | null;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
  properties?: Record<string, { $value?: unknown }> | null;
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

const AREA_DEPTH = 6;

interface RawClassificationNode {
  name?: string;
  path?: string;
  children?: RawClassificationNode[];
}

function areaNodePath(node: RawClassificationNode): string | null {
  const raw = typeof node.path === 'string' && node.path !== '' ? node.path : null;
  if (raw === null) return null;
  const parts = raw.split('\\').filter((p) => p !== '');
  if (parts.length === 0) return null;
  return [parts[0], ...parts.slice(1).filter((p) => p !== 'Area')].join('\\');
}

function flattenThreadProperties(raw: Record<string, { $value?: unknown }> | null | undefined) {
  if (raw === null || raw === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, wrapper] of Object.entries(raw)) {
    const value = wrapper?.$value;
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface RawWorkItemUpdate {
  revisedBy?: { uniqueName?: string };
  fields?: Record<string, { oldValue?: string; newValue?: string }>;
}

interface RawTimelineRecord {
  type?: string;
  name?: string;
  result?: string | null;
  log?: { id?: number } | null;
  issues?: Array<{ type?: string; message?: string }>;
}

interface RawPolicyEvaluation {
  evaluationId?: string;
  status?: string | null;
  context?: { buildDefinitionName?: string; isExpired?: boolean; buildId?: number } | null;
  configuration?: {
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { id?: string; displayName?: string };
    settings?: { displayName?: string; statusName?: string; statusGenre?: string; defaultDisplayName?: string };
  };
}

export function policyDisplayName(e: RawPolicyEvaluation): string {
  const s = e.configuration?.settings;
  if (s?.displayName) return s.displayName;
  if (s?.statusName) return s.statusGenre ? `${s.statusGenre}/${s.statusName}` : s.statusName;
  if (e.context?.buildDefinitionName) return e.context.buildDefinitionName;
  return e.configuration?.type?.displayName ?? '';
}

export function policyDisplayAliases(e: RawPolicyEvaluation): string[] {
  const primary = policyDisplayName(e);
  const alias = e.configuration?.settings?.defaultDisplayName;
  return alias && alias !== primary ? [alias] : [];
}

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSignInHtml(contentType: string | null, body: string): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return /^\s*<(?:!doctype|html)\b/i.test(body);
}

export function isRelationAlreadyExists(message: string): boolean {
  return /WorkItemRelationAlreadyExists|relation already exists/i.test(message);
}

export class RestAzureDevOpsApi implements AzureDevOpsApi {
  private viewer: string | null = null;
  private readonly etags = new AzureEtagCache();
  private projectId: string | null = null;
  private repositoryId: string | null = null;

  constructor(
    private readonly organization: string,
    private readonly project: string,
    private readonly repository: string,
    private readonly auth: AzureAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => {},
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  static create(
    cfg: { organization: string; project: string; repository: string },
    auth: AzureAuth,
    log?: (message: string) => void,
  ): RestAzureDevOpsApi {
    return new RestAzureDevOpsApi(cfg.organization, cfg.project, cfg.repository, auth, fetch, log);
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

  private async request<T>(url: string, init: RequestInit = {}, opts: { conditional?: boolean } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const conditional = opts.conditional !== false;
    const cached = method === 'GET' && conditional ? this.etags.get(url) : undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        this.auth.forceRefresh?.();
        await this.sleep(RETRY_BACKOFF_MS * attempt);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          headers: {
            Authorization: await this.auth.header(),
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(cached ? { 'If-None-Match': cached.etag } : {}),
            ...init.headers,
          },
        });
      } catch (err) {
        lastError = new Error(`Azure DevOps ${method} ${url}: network error: ${(err as Error).message}`);
        continue;
      }

      const body = await res.text().catch(() => '');
      const contentType = res.headers.get('content-type');

      if (res.status === 304 && cached) return JSON.parse(cached.body) as T;

      if (!res.ok) {
        lastError = new Error(
          `Azure DevOps ${method} ${url} -> ${res.status} ${res.statusText} ` +
            `(${contentType ?? 'no content-type'}): ${body.slice(0, 300)}`,
        );
        if (res.status === 429 || res.status >= 500) continue;
        throw lastError;
      }

      if (body.trim() === '') return undefined as T;

      if (isSignInHtml(contentType, body)) {
        lastError = new Error(
          `Azure DevOps ${method} ${url} -> ${res.status} returned an HTML sign-in page instead of JSON — ` +
            `the credential was rejected. Check \`az login\` (or AZURE_DEVOPS_PAT) and the organization name. ` +
            `Body: ${body.slice(0, 200)}`,
        );
        continue;
      }

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

    const exhausted = lastError ?? new Error(`Azure DevOps ${method} ${url}: failed after ${MAX_RETRIES} retries`);
    this.log(`Azure DevOps ${method} ${url}: failed after ${MAX_RETRIES + 1} attempts — ${exhausted.message}`);
    throw exhausted;
  }

  private withApiVersion(url: string, params: Record<string, string> = {}, apiVersion: string = API_VERSION): string {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('api-version', apiVersion);
    return u.toString();
  }

  async viewerUniqueName(): Promise<string> {
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
      authorDisplayName: p.createdBy?.displayName ?? '',
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${p.pullRequestId}`,
      isDraft: p.isDraft ?? false,
      mergeStatus: p.mergeStatus ?? 'notSet',
      reviewers: (p.reviewers ?? []).map((r) => ({
        uniqueName: r.uniqueName ?? '',
        vote: r.vote ?? 0,
        isRequired: r.isRequired ?? false,
        isContainer: r.isContainer ?? false,
      })),
    }));
  }

  async listRecentlyClosedPullRequests(since: string): Promise<AzClosedPull[]> {
    const data = await this.request<{ value: RawClosedPull[] }>(
      this.withApiVersion(`${this.repoUrl}/pullrequests`, {
        'searchCriteria.status': 'all',
        'searchCriteria.queryTimeRangeType': 'closed',
        'searchCriteria.minTime': since,
        $top: '100',
      }),
    );
    const out: AzClosedPull[] = [];
    for (const p of data.value) {
      if (p.status !== 'completed' && p.status !== 'abandoned') continue;
      const closedAt = p.closedDate;
      if (!withinClosedWindow(closedAt, since)) continue;
      out.push({
        pullRequestId: p.pullRequestId,
        title: p.title,
        branch: stripRef(p.sourceRefName),
        baseBranch: stripRef(p.targetRefName),
        authorUniqueName: p.createdBy?.uniqueName ?? '',
        url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${p.pullRequestId}`,
        merged: p.status === 'completed',
        closedAt,
        mergeCommitSha: p.status === 'completed' ? (p.lastMergeCommit?.commitId ?? null) : null,
      });
    }
    return out;
  }

  async listPullThreads(pullRequestId: number): Promise<AzThread[]> {
    const data = await this.request<{ value: RawThread[] }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
    );
    return data.value.map((t) => ({
      id: t.id,
      status: t.status ?? null,
      filePath: t.threadContext?.filePath ?? null,
      line: t.threadContext?.rightFileStart?.line ?? t.threadContext?.leftFileStart?.line ?? null,
      properties: flattenThreadProperties(t.properties),
      comments: (t.comments ?? []).map((c) => ({
        id: c.id,
        authorUniqueName: c.author?.uniqueName ?? '',
        content: c.content ?? '',
        parentCommentId: c.parentCommentId ?? null,
        commentType: c.commentType ?? 'text',
      })),
    }));
  }

  private async resolveProjectId(): Promise<string> {
    if (this.projectId === null) {
      const data = await this.request<{ id?: string }>(
        this.withApiVersion(`${this.orgUrl}/_apis/projects/${encodeURIComponent(this.project)}`),
      );
      this.projectId = data.id ?? '';
    }
    return this.projectId;
  }

  private async resolveRepositoryId(): Promise<string> {
    if (this.repositoryId === null) {
      const data = await this.request<{ id?: string }>(this.withApiVersion(this.repoUrl));
      this.repositoryId = data.id ?? '';
    }
    return this.repositoryId;
  }

  async listPolicyEvaluations(pullRequestId: number): Promise<AzPolicyEvaluation[]> {
    const projectId = await this.resolveProjectId();
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
    const data = await this.request<{ value: RawPolicyEvaluation[] }>(
      this.withApiVersion(`${this.projectUrl}/_apis/policy/evaluations`, { artifactId }, POLICY_API_VERSION),
    );
    return data.value.map((e) => ({
      evaluationId: e.evaluationId,
      typeId: e.configuration?.type?.id ?? '',
      displayName: policyDisplayName(e),
      displayAliases: policyDisplayAliases(e),
      typeName: e.configuration?.type?.displayName ?? '',
      buildDefinitionName: e.context?.buildDefinitionName,
      buildId: e.context?.buildId,
      status: e.status ?? null,
      isExpired: e.context?.isExpired,
      isBlocking: e.configuration?.isBlocking ?? false,
      isEnabled: e.configuration?.isEnabled ?? false,
    }));
  }

  async requeuePolicyEvaluation(evaluationId: string): Promise<AzPolicyRequeue> {
    const data = await this.request<RawPolicyEvaluation>(
      this.withApiVersion(
        `${this.projectUrl}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}`,
        {},
        POLICY_API_VERSION,
      ),
      { method: 'PATCH' },
    );
    return { status: data?.status ?? null, isExpired: data?.context?.isExpired };
  }

  async getBuildTimeline(buildId: number): Promise<AzTimelineRecord[]> {
    const data = await this.request<{ records?: RawTimelineRecord[] }>(
      this.withApiVersion(`${this.projectUrl}/_apis/build/builds/${buildId}/timeline`),
    );
    return (data.records ?? []).map((r) => ({
      type: r.type ?? '',
      name: r.name ?? '',
      result: r.result ?? null,
      logId: r.log?.id ?? null,
      issues: (r.issues ?? []).map((i) => ({ type: i.type ?? '', message: i.message ?? '' })),
    }));
  }

  async getBuildLog(buildId: number, logId: number): Promise<string[]> {
    const data = await this.request<{ value?: string[] }>(
      this.withApiVersion(`${this.projectUrl}/_apis/build/builds/${buildId}/logs/${logId}`),
    );
    return Array.isArray(data?.value) ? data.value : [];
  }

  async listPullLabels(pullRequestId: number): Promise<string[]> {
    const data = await this.request<{ value: Array<{ name?: string }> }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/labels`),
    );
    return data.value.map((l) => l.name ?? '').filter((name) => name !== '');
  }

  async listOpenWorkItems(tag?: string, assignedTo?: string): Promise<AzWorkItem[]> {
    return this.runWorkItemQuery(buildOpenWorkItemQuery(tag, assignedTo));
  }

  async listWorkItemsChangedSince(since: string, tag?: string, assignedTo?: string): Promise<AzWorkItem[]> {
    return this.runWorkItemQuery(buildWorkItemHistoryQuery(since, tag, assignedTo), true);
  }

  private async runWorkItemQuery(wiql: string, timePrecision = false): Promise<AzWorkItem[]> {
    const query = await this.request<{ workItems?: Array<{ id: number }> }>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/wiql`, timePrecision ? { timePrecision: 'true' } : {}),
      { method: 'POST', body: JSON.stringify({ query: wiql }) },
    );
    const ids = (query.workItems ?? []).map((w) => w.id);
    return this.getWorkItems(ids);
  }

  async getWorkItems(ids: number[]): Promise<AzWorkItem[]> {
    if (ids.length === 0) return [];
    const items: AzWorkItem[] = [];
    for (const chunk of chunkIds(ids, 200)) {
      const batch = await this.request<{ value: RawWorkItem[] }>(
        this.withApiVersion(`${this.orgUrl}/_apis/wit/workitemsbatch`),
        { method: 'POST', body: JSON.stringify({ ids: chunk, $expand: 'Relations', errorPolicy: 'omit' }) },
      );
      for (const w of batch.value) if (w && typeof w.id === 'number') items.push(this.mapWorkItem(w));
    }
    return items;
  }

  async listWorkItemUpdates(id: number): Promise<AzWorkItemUpdate[]> {
    const data = await this.request<{ value: RawWorkItemUpdate[] }>(
      this.withApiVersion(`${this.orgUrl}/_apis/wit/workItems/${id}/updates`),
    );
    return data.value.map((u) => {
      const tags = u.fields?.['System.Tags'];
      return {
        revisedByUniqueName: u.revisedBy?.uniqueName ?? '',
        tagsOld: tags?.oldValue,
        tagsNew: tags?.newValue,
      };
    });
  }

  private mapWorkItem(w: RawWorkItem): AzWorkItem {
    const fields = w.fields ?? {};
    const rawTags = String(fields['System.Tags'] ?? '');
    return {
      id: w.id,
      title: String(fields['System.Title'] ?? ''),
      body: composeWorkItemBody(fields),
      state: String(fields['System.State'] ?? ''),
      tags: rawTags
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      workItemType: String(fields['System.WorkItemType'] ?? ''),
      areaPath: String(fields['System.AreaPath'] ?? ''),
      createdAt: String(fields['System.CreatedDate'] ?? ''),
      changedAt: String(fields['System.ChangedDate'] ?? ''),
      relationUrls: (w.relations ?? [])
        .filter((r) => r.rel === 'ArtifactLink' && typeof r.url === 'string')
        .map((r) => r.url as string),
      parentId: hierarchyIds(w.relations, 'System.LinkTypes.Hierarchy-Reverse')[0] ?? null,
      childIds: hierarchyIds(w.relations, 'System.LinkTypes.Hierarchy-Forward'),
      dependsOnIds: hierarchyIds(w.relations, 'System.LinkTypes.Dependency-Reverse'),
      url: `${this.projectUrl}/_workitems/edit/${w.id}`,
    };
  }

  async createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef> {
    const created = await this.request<{ id?: number }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}/comments`),
      { method: 'POST', body: JSON.stringify({ content, parentCommentId, commentType: 'text' }) },
    );
    return {
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}`,
      ...(typeof created?.id === 'number' ? { id: created.id } : {}),
    };
  }

  async setThreadStatus(pullRequestId: number, threadId: number, status: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async createThread(pullRequestId: number, content: string): Promise<AzCommentRef> {
    const created = await this.request<{ id?: number; comments?: { id?: number }[] }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
      { method: 'POST', body: JSON.stringify({ comments: [{ content, commentType: 'text' }], status: 'active' }) },
    );
    const id = created?.comments?.[0]?.id;
    const threadId = created?.id;
    return {
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}`,
      ...(typeof id === 'number' ? { id } : {}),
      ...(typeof threadId === 'number' ? { threadId } : {}),
    };
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

  async abandonPullRequest(pullRequestId: number): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status: 'abandoned' }),
    });
  }

  async setWorkItemState(id: number, state: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }]),
    });
  }

  async createWorkItemComment(id: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.request<{ id?: number }>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/workItems/${id}/comments`, {}, WORK_ITEM_COMMENTS_API_VERSION),
      { method: 'POST', body: JSON.stringify({ text }) },
    );
    return { id: data.id ?? 0 };
  }

  async updateWorkItemComment(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.request<{ id?: number }>(
      this.withApiVersion(
        `${this.projectUrl}/_apis/wit/workItems/${id}/comments/${commentId}`,
        {},
        WORK_ITEM_COMMENTS_API_VERSION,
      ),
      { method: 'PATCH', body: JSON.stringify({ text }) },
    );
    return { id: data.id ?? commentId };
  }

  async linkWorkItemToPull(id: number, pullRequestId: number): Promise<void> {
    const [projectId, repositoryId] = await Promise.all([this.resolveProjectId(), this.resolveRepositoryId()]);
    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2F${repositoryId}%2F${pullRequestId}`;
    try {
      await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          {
            op: 'add',
            path: '/relations/-',
            value: { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } },
          },
        ]),
      });
    } catch (err) {
      if (!isRelationAlreadyExists((err as Error).message)) throw err;
    }
  }

  async createWorkItem(input: {
    type: string;
    title: string;
    description: string;
    tags: string[];
    assignedTo: string | null;
  }): Promise<{ id: number }> {
    const url = `${this.projectUrl}/_apis/wit/workitems/$${encodeURIComponent(input.type)}`;
    const patch: { op: string; path: string; value: string }[] = [
      { op: 'add', path: '/fields/System.Title', value: input.title },
      { op: 'add', path: '/fields/System.Description', value: input.description },
    ];
    if (input.tags.length > 0) patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
    if (input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assignedTo });
    const data = await this.request<{ id: number }>(this.withApiVersion(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch),
    });
    return { id: data.id };
  }

  async relateWorkItem(id: number, relatedId: number): Promise<void> {
    try {
      await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          {
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Related',
              url: `${this.orgUrl}/_apis/wit/workItems/${relatedId}`,
            },
          },
        ]),
      });
    } catch (err) {
      if (!isRelationAlreadyExists((err as Error).message)) throw err;
    }
  }

  async listAreaPaths(): Promise<AreaPathTree> {
    const data = await this.request<RawClassificationNode>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/classificationnodes/areas`, { $depth: String(AREA_DEPTH) }),
    );
    const root = areaNodePath(data) ?? this.project;
    const paths: string[] = [];
    const walk = (node: RawClassificationNode): void => {
      for (const child of node.children ?? []) {
        const path = areaNodePath(child);
        if (path !== null) paths.push(path);
        walk(child);
      }
    };
    walk(data);
    return { root, paths };
  }

  async setWorkItemParent(id: number, parentId: number): Promise<void> {
    try {
      await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          {
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: `${this.orgUrl}/_apis/wit/workItems/${parentId}`,
            },
          },
        ]),
      });
    } catch (err) {
      if (!isRelationAlreadyExists((err as Error).message)) throw err;
    }
  }

  async setWorkItemAreaPath(id: number, areaPath: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.AreaPath', value: areaPath }]),
    });
  }

  async setWorkItemTag(id: number, tag: string, present: boolean): Promise<void> {
    const wi = await this.request<{ fields?: Record<string, unknown> }>(
      this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}?fields=System.Tags`),
      {},
      { conditional: false },
    );
    const current = parseTags(String(wi?.fields?.['System.Tags'] ?? ''));
    if (current.some((t) => sameTag(t, tag)) === present) return;
    const kept = current.filter((t) => !sameTag(t, tag));
    const tags = present ? [...kept, tag] : kept;
    const patch = [
      { op: 'remove', path: '/fields/System.Tags' },
      { op: 'add', path: '/fields/System.Tags', value: tags.join('; ') },
    ];
    const updated = await this.request<{ fields?: Record<string, unknown> }>(
      this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(patch),
      },
    );
    const fields = updated?.fields;
    if (fields === undefined || fields === null) return;
    const after = parseTags(String(fields['System.Tags'] ?? ''));
    if (after.some((t) => sameTag(t, tag)) === present) return;
    throw new Error(
      `Azure DevOps accepted the tag write on #${id} but the item still reads ` +
        `[${after.join('; ')}] — "${tag}" was ${present ? 'not added' : 'not removed'}`,
    );
  }

  async createPull(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ pullRequestId: number }> {
    const data = await this.request<{ pullRequestId: number }>(this.withApiVersion(`${this.repoUrl}/pullrequests`), {
      method: 'POST',
      body: JSON.stringify({
        sourceRefName: headsRef(input.head),
        targetRefName: headsRef(input.base),
        title: input.title,
        description: input.body,
      }),
    });
    return { pullRequestId: data.pullRequestId };
  }

  async setPullTitle(pullRequestId: number, title: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  async setPullBase(pullRequestId: number, base: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ targetRefName: headsRef(base) }),
    });
  }

  async deleteBranch(branch: string): Promise<boolean> {
    const plain = branch.replace(/^refs\/heads\//, '');
    const refs = await this.request<{ value: { name: string; objectId: string }[] }>(
      this.withApiVersion(`${this.repoUrl}/refs`, { filter: `heads/${plain}` }),
    );
    const ref = refs.value.find((r) => r.name === headsRef(plain));
    if (!ref) return false;
    await this.request(this.withApiVersion(`${this.repoUrl}/refs`), {
      method: 'POST',
      body: JSON.stringify([{ name: ref.name, oldObjectId: ref.objectId, newObjectId: ZERO_OBJECT_ID }]),
    });
    return true;
  }

  async setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void> {
    const labelsUrl = `${this.repoUrl}/pullRequests/${pullRequestId}/labels`;
    if (present) {
      await this.request(this.withApiVersion(labelsUrl), { method: 'POST', body: JSON.stringify({ name: label }) });
    } else {
      try {
        await this.request(this.withApiVersion(`${labelsUrl}/${encodeURIComponent(label)}`), { method: 'DELETE' });
      } catch (err) {
        if (!/-> 404\b/.test((err as Error).message)) throw err;
      }
    }
  }
}

function headsRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

export function buildOpenWorkItemQuery(tag?: string, assignedTo?: string): string {
  return workItemQuery(["[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')"], tag, assignedTo);
}

export function buildWorkItemHistoryQuery(since: string, tag?: string, assignedTo?: string): string {
  return workItemQuery([`[System.ChangedDate] >= '${wiqlDate(since)}'`], tag, assignedTo);
}

function workItemQuery(extra: string[], tag?: string, assignedTo?: string): string {
  const clauses = ['[System.TeamProject] = @project', ...extra];
  if (tag) clauses.push(`[System.Tags] CONTAINS '${tag.replace(/'/g, "''")}'`);
  if (assignedTo) clauses.push(`[System.AssignedTo] = '${assignedTo.replace(/'/g, "''")}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.Id] ASC`;
}

function wiqlDate(iso: string): string {
  return iso.replace(/'/g, '').replace('T', ' ').replace(/\.\d+/, '').replace(/Z?$/, 'Z');
}

export function hierarchyIds(relations: RawWorkItem['relations'], rel: string): number[] {
  const ids: number[] = [];
  for (const r of relations ?? []) {
    if (r.rel !== rel || typeof r.url !== 'string') continue;
    const match = /\/workItems\/(\d+)(?:[?#].*)?$/i.exec(r.url);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

function sameTag(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}
