import type { AzCommentRef } from './azureDevOpsApi.js';
import { withApiVersion, type AzureTransport } from './azureTransport.js';

// → docs/spec/15-integrations.md

export class RestPullThreads {
  constructor(
    private readonly http: AzureTransport,
    private readonly repoUrl: string,
    private readonly pullUrl: (pullRequestId: number) => string,
  ) {}

  private url(pullRequestId: number, tail = ''): string {
    return withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads${tail}`);
  }

  async reply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef> {
    const created = await this.http.request<{ id?: number }>(this.url(pullRequestId, `/${threadId}/comments`), {
      method: 'POST',
      body: JSON.stringify({ content, parentCommentId, commentType: 'text' }),
    });
    return {
      url: this.pullUrl(pullRequestId),
      ...(typeof created?.id === 'number' ? { id: created.id } : {}),
    };
  }

  async update(pullRequestId: number, threadId: number, commentId: number, content: string): Promise<AzCommentRef> {
    await this.http.request(this.url(pullRequestId, `/${threadId}/comments/${commentId}`), {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
    return { url: this.pullUrl(pullRequestId), id: commentId };
  }

  async setStatus(pullRequestId: number, threadId: number, status: string): Promise<void> {
    await this.http.request(this.url(pullRequestId, `/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async create(pullRequestId: number, content: string): Promise<AzCommentRef> {
    const created = await this.http.request<{ id?: number; comments?: { id?: number }[] }>(this.url(pullRequestId), {
      method: 'POST',
      body: JSON.stringify({ comments: [{ content, commentType: 'text' }], status: 'active' }),
    });
    const id = created?.comments?.[0]?.id;
    const threadId = created?.id;
    return {
      url: this.pullUrl(pullRequestId),
      ...(typeof id === 'number' ? { id } : {}),
      ...(typeof threadId === 'number' ? { threadId } : {}),
    };
  }
}
