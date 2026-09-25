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
  AzAttachmentRef,
  AzWorkItemCommentRef,
  AzWorkItemUpdate,
  AzureDevOpsApi,
} from './azureDevOpsApi.js';
import type { AzureAuth } from './azureAuth.js';
import { AzureTransport, defaultSleep, withApiVersion } from './azureTransport.js';
import {
  areaPaths,
  toClosedPull,
  toPolicyEvaluation,
  toPull,
  toThread,
  toTimelineRecord,
  toWorkItem,
  type RawClassificationNode,
  type RawClosedPull,
  type RawPolicyEvaluation,
  type RawPull,
  type RawThread,
  type RawTimelineRecord,
  type RawWorkItem,
  type RawWorkItemUpdate,
} from './restShapes.js';
import { mergeStrategyFor } from './sourceControl.js';
import { parseTags } from './workItems.js';
import { workItemBodyField } from './workItemBody.js';
import { buildOpenWorkItemQuery, buildWorkItemHistoryQuery } from './wiql.js';

// → docs/spec/15-integrations.md

const CONNECTION_DATA_API_VERSION = '7.1-preview.1';

const POLICY_API_VERSION = '7.1-preview.1';

const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

const WORK_ITEM_COMMENTS_API_VERSION = '7.1-preview.4';

const AREA_DEPTH = 6;

export function isRelationAlreadyExists(message: string): boolean {
  return /WorkItemRelationAlreadyExists|relation already exists/i.test(message);
}

export class RestAzureDevOpsApi implements AzureDevOpsApi {
  private viewer: string | null = null;
  private readonly http: AzureTransport;
  private projectId: string | null = null;
  private repositoryId: string | null = null;

  constructor(
    private readonly organization: string,
    private readonly project: string,
    private readonly repository: string,
    auth: AzureAuth,
    fetchImpl: typeof fetch = fetch,
    log: (message: string) => void = () => {},
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.http = new AzureTransport(auth, fetchImpl, log, sleep);
  }

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

  async viewerUniqueName(): Promise<string> {
    if (this.viewer === null) {
      const data = await this.http.request<{
        authenticatedUser?: { properties?: { Account?: { $value?: string } }; providerDisplayName?: string };
      }>(withApiVersion(`${this.orgUrl}/_apis/connectionData`, {}, CONNECTION_DATA_API_VERSION));
      const user = data.authenticatedUser;
      this.viewer = user?.properties?.Account?.$value ?? user?.providerDisplayName ?? '';
    }
    return this.viewer;
  }

  async listActivePullRequests(): Promise<AzPull[]> {
    const data = await this.http.request<{ value: RawPull[] }>(
      withApiVersion(`${this.repoUrl}/pullrequests`, { 'searchCriteria.status': 'active', $top: '100' }),
    );
    return data.value.map((p) => toPull(p, this.pullUrl(p.pullRequestId)));
  }

  async listRecentlyClosedPullRequests(since: string): Promise<AzClosedPull[]> {
    const data = await this.http.request<{ value: RawClosedPull[] }>(
      withApiVersion(`${this.repoUrl}/pullrequests`, {
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
      out.push(toClosedPull(p, closedAt, this.pullUrl(p.pullRequestId)));
    }
    return out;
  }

  async listPullThreads(pullRequestId: number): Promise<AzThread[]> {
    const data = await this.http.request<{ value: RawThread[] }>(
      withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
    );
    return data.value.map(toThread);
  }

  private pullUrl(pullRequestId: number): string {
    return `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}`;
  }

  private async resolveProjectId(): Promise<string> {
    if (this.projectId === null) {
      const data = await this.http.request<{ id?: string }>(
        withApiVersion(`${this.orgUrl}/_apis/projects/${encodeURIComponent(this.project)}`),
      );
      this.projectId = data.id ?? '';
    }
    return this.projectId;
  }

  private async resolveRepositoryId(): Promise<string> {
    if (this.repositoryId === null) {
      const data = await this.http.request<{ id?: string }>(withApiVersion(this.repoUrl));
      this.repositoryId = data.id ?? '';
    }
    return this.repositoryId;
  }

  async listPolicyEvaluations(pullRequestId: number): Promise<AzPolicyEvaluation[]> {
    const projectId = await this.resolveProjectId();
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
    const data = await this.http.request<{ value: RawPolicyEvaluation[] }>(
      withApiVersion(`${this.projectUrl}/_apis/policy/evaluations`, { artifactId }, POLICY_API_VERSION),
    );
    return data.value.map(toPolicyEvaluation);
  }

  async requeuePolicyEvaluation(evaluationId: string): Promise<AzPolicyRequeue> {
    const data = await this.http.request<RawPolicyEvaluation>(
      withApiVersion(
        `${this.projectUrl}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}`,
        {},
        POLICY_API_VERSION,
      ),
      { method: 'PATCH' },
    );
    return { status: data?.status ?? null, isExpired: data?.context?.isExpired };
  }

  async getBuildTimeline(buildId: number): Promise<AzTimelineRecord[]> {
    const data = await this.http.request<{ records?: RawTimelineRecord[] }>(
      withApiVersion(`${this.projectUrl}/_apis/build/builds/${buildId}/timeline`),
    );
    return (data.records ?? []).map(toTimelineRecord);
  }

  async getBuildLog(buildId: number, logId: number): Promise<string[]> {
    const data = await this.http.request<{ value?: string[] }>(
      withApiVersion(`${this.projectUrl}/_apis/build/builds/${buildId}/logs/${logId}`),
    );
    return Array.isArray(data?.value) ? data.value : [];
  }

  async listPullLabels(pullRequestId: number): Promise<string[]> {
    const data = await this.http.request<{ value: Array<{ name?: string }> }>(
      withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/labels`),
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
    const query = await this.http.request<{ workItems?: Array<{ id: number }> }>(
      withApiVersion(`${this.projectUrl}/_apis/wit/wiql`, timePrecision ? { timePrecision: 'true' } : {}),
      { method: 'POST', body: JSON.stringify({ query: wiql }) },
    );
    const ids = (query.workItems ?? []).map((w) => w.id);
    return this.getWorkItems(ids);
  }

  async getWorkItems(ids: number[]): Promise<AzWorkItem[]> {
    if (ids.length === 0) return [];
    const items: AzWorkItem[] = [];
    for (const chunk of chunkIds(ids, 200)) {
      const batch = await this.http.request<{ value: RawWorkItem[] }>(
        withApiVersion(`${this.orgUrl}/_apis/wit/workitemsbatch`),
        { method: 'POST', body: JSON.stringify({ ids: chunk, $expand: 'Relations', errorPolicy: 'omit' }) },
      );
      for (const w of batch.value)
        if (w && typeof w.id === 'number') items.push(toWorkItem(w, `${this.projectUrl}/_workitems/edit/${w.id}`));
    }
    return items;
  }

  async listWorkItemUpdates(id: number): Promise<AzWorkItemUpdate[]> {
    const data = await this.http.request<{ value: RawWorkItemUpdate[] }>(
      withApiVersion(`${this.orgUrl}/_apis/wit/workItems/${id}/updates`),
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

  async createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef> {
    const created = await this.http.request<{ id?: number }>(
      withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}/comments`),
      { method: 'POST', body: JSON.stringify({ content, parentCommentId, commentType: 'text' }) },
    );
    return {
      url: this.pullUrl(pullRequestId),
      ...(typeof created?.id === 'number' ? { id: created.id } : {}),
    };
  }

  async setThreadStatus(pullRequestId: number, threadId: number, status: string): Promise<void> {
    await this.http.request(withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async createThread(pullRequestId: number, content: string): Promise<AzCommentRef> {
    const created = await this.http.request<{ id?: number; comments?: { id?: number }[] }>(
      withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
      { method: 'POST', body: JSON.stringify({ comments: [{ content, commentType: 'text' }], status: 'active' }) },
    );
    const id = created?.comments?.[0]?.id;
    const threadId = created?.id;
    return {
      url: this.pullUrl(pullRequestId),
      ...(typeof id === 'number' ? { id } : {}),
      ...(typeof threadId === 'number' ? { threadId } : {}),
    };
  }

  async completePullRequest(
    pullRequestId: number,
    lastMergeSourceCommit: string,
    method: MergeMethod,
  ): Promise<AzMergeResult> {
    const data = await this.http.request<{ status?: string }>(
      withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`),
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
    await this.http.request(withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status: 'abandoned' }),
    });
  }

  async setWorkItemState(id: number, state: string): Promise<void> {
    await this.http.request(withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }]),
    });
  }

  /**
   * The bytes, into the **project's** attachment store. It is the one request in this client that
   * sends something other than JSON, so it names its own `Content-Type`: `request` defaults a body to
   * `application/json`, and an octet-stream posted as JSON is rejected with a parse error that says
   * nothing about what was wrong.
   *
   * `fileName` is a query parameter and the tracker's own name for the file — never a path. What the
   * harness calls the file on disk is the harness's business.
   */
  async createWorkItemAttachment(fileName: string, bytes: Buffer): Promise<AzAttachmentRef> {
    const data = await this.http.request<{ id?: string; url?: string }>(
      withApiVersion(`${this.projectUrl}/_apis/wit/attachments`, { fileName }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      },
    );
    if (typeof data.url !== 'string' || data.url === '')
      throw new Error(`Azure DevOps accepted the attachment "${fileName}" but named no URL for it`);
    return { id: data.id ?? '', url: data.url };
  }

  /**
   * **Not an optional tidy.** Azure DevOps prunes attachments no work item references, so an image
   * embedded by URL alone is a picture that works today and is a broken image in the comment later —
   * the quietest possible failure, because the comment still reads correctly.
   *
   * An attachment already held is not an error: the same screen re-linked is the state we wanted.
   */
  async linkWorkItemAttachment(id: number, url: string, comment: string): Promise<void> {
    await this.addRelation(id, { rel: 'AttachedFile', url, attributes: { comment } });
  }

  async createWorkItemComment(id: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.http.request<{ id?: number }>(
      withApiVersion(`${this.projectUrl}/_apis/wit/workItems/${id}/comments`, {}, WORK_ITEM_COMMENTS_API_VERSION),
      { method: 'POST', body: JSON.stringify({ text }) },
    );
    return { id: data.id ?? 0 };
  }

  async updateWorkItemComment(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.http.request<{ id?: number }>(
      withApiVersion(
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
    await this.addRelation(id, { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } });
  }

  private async addRelation(id: number, value: Record<string, unknown>): Promise<void> {
    try {
      await this.http.request(withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([{ op: 'add', path: '/relations/-', value }]),
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
      { op: 'add', path: `/fields/${workItemBodyField(input.type)}`, value: input.description },
    ];
    if (input.tags.length > 0) patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
    if (input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assignedTo });
    const data = await this.http.request<{ id: number }>(withApiVersion(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch),
    });
    return { id: data.id };
  }

  async relateWorkItem(id: number, relatedId: number): Promise<void> {
    await this.addRelation(id, {
      rel: 'System.LinkTypes.Related',
      url: `${this.orgUrl}/_apis/wit/workItems/${relatedId}`,
    });
  }

  async listAreaPaths(): Promise<AreaPathTree> {
    const data = await this.http.request<RawClassificationNode>(
      withApiVersion(`${this.projectUrl}/_apis/wit/classificationnodes/areas`, { $depth: String(AREA_DEPTH) }),
    );
    return areaPaths(data, this.project);
  }

  async setWorkItemParent(id: number, parentId: number): Promise<void> {
    await this.addRelation(id, {
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: `${this.orgUrl}/_apis/wit/workItems/${parentId}`,
    });
  }

  async setWorkItemAreaPath(id: number, areaPath: string): Promise<void> {
    await this.http.request(withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.AreaPath', value: areaPath }]),
    });
  }

  async setWorkItemTag(id: number, tag: string, present: boolean): Promise<void> {
    const wi = await this.http.request<{ fields?: Record<string, unknown> }>(
      withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}?fields=System.Tags`),
      {},
      { conditional: false },
    );
    const current = parseTags(String(wi?.fields?.['System.Tags'] ?? ''));
    if (current.some((t) => sameTag(t, tag)) === present) return;
    const kept = current.filter((t) => !sameTag(t, tag));
    const tags = present ? [...kept, tag] : kept;
    const patch = [tagWriteOp(current, tags)];
    const updated = await this.http.request<{ fields?: Record<string, unknown> }>(
      withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`),
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
    const data = await this.http.request<{ pullRequestId: number }>(withApiVersion(`${this.repoUrl}/pullrequests`), {
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
    await this.http.request(withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  async setPullBody(pullRequestId: number, body: string): Promise<void> {
    await this.http.request(withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ description: body }),
    });
  }

  async setPullBase(pullRequestId: number, base: string): Promise<void> {
    await this.http.request(withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ targetRefName: headsRef(base) }),
    });
  }

  async deleteBranch(branch: string): Promise<boolean> {
    const plain = branch.replace(/^refs\/heads\//, '');
    const refs = await this.http.request<{ value: { name: string; objectId: string }[] }>(
      withApiVersion(`${this.repoUrl}/refs`, { filter: `heads/${plain}` }),
    );
    const ref = refs.value.find((r) => r.name === headsRef(plain));
    if (!ref) return false;
    await this.http.request(withApiVersion(`${this.repoUrl}/refs`), {
      method: 'POST',
      body: JSON.stringify([{ name: ref.name, oldObjectId: ref.objectId, newObjectId: ZERO_OBJECT_ID }]),
    });
    return true;
  }

  async setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void> {
    const labelsUrl = `${this.repoUrl}/pullRequests/${pullRequestId}/labels`;
    if (present) {
      await this.http.request(withApiVersion(labelsUrl), { method: 'POST', body: JSON.stringify({ name: label }) });
    } else {
      try {
        await this.http.request(withApiVersion(`${labelsUrl}/${encodeURIComponent(label)}`), { method: 'DELETE' });
      } catch (err) {
        if (!/-> 404\b/.test((err as Error).message)) throw err;
      }
    }
  }
}

function headsRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

function tagWriteOp(current: readonly string[], tags: readonly string[]): { op: string; path: string; value?: string } {
  const path = '/fields/System.Tags';
  if (tags.length === 0) return { op: 'remove', path };
  if (current.length === 0) return { op: 'add', path, value: tags.join('; ') };
  return { op: 'replace', path, value: tags.join('; ') };
}

function sameTag(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}
