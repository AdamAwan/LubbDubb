import type { AzWorkItemComment, AzWorkItemCommentRef } from './azureDevOpsApi.js';
import { withApiVersion, type AzureTransport } from './azureTransport.js';

// → docs/spec/15-integrations.md

const WORK_ITEM_COMMENTS_API_VERSION = '7.1-preview.4';

interface RawWorkItemCommentPage {
  comments?: {
    id: number;
    text?: string;
    createdDate?: string;
    createdBy?: { uniqueName?: string; displayName?: string };
    isDeleted?: boolean;
  }[];
  continuationToken?: string | null;
}

export class RestWorkItemComments {
  constructor(
    private readonly http: AzureTransport,
    private readonly projectUrl: string,
  ) {}

  private url(id: number, tail = '', params: Record<string, string> = {}): string {
    return withApiVersion(
      `${this.projectUrl}/_apis/wit/workItems/${id}/comments${tail}`,
      params,
      WORK_ITEM_COMMENTS_API_VERSION,
    );
  }

  async list(id: number): Promise<AzWorkItemComment[]> {
    const found: AzWorkItemComment[] = [];
    let continuation: string | null = null;
    do {
      const params: Record<string, string> = { $top: '200', order: 'asc' };
      if (continuation !== null) params.continuationToken = continuation;
      const page: RawWorkItemCommentPage = await this.http.request<RawWorkItemCommentPage>(this.url(id, '', params));
      for (const c of page.comments ?? []) {
        if (c.isDeleted) continue;
        found.push({
          id: c.id,
          author: c.createdBy?.uniqueName ?? c.createdBy?.displayName ?? 'unknown',
          text: c.text ?? '',
          createdDate: c.createdDate ?? '',
        });
      }
      continuation = page.continuationToken ? page.continuationToken : null;
    } while (continuation !== null);
    return found;
  }

  async create(id: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.http.request<{ id?: number }>(this.url(id), {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    return { id: data.id ?? 0 };
  }

  async update(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.http.request<{ id?: number }>(this.url(id, `/${commentId}`), {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    });
    return { id: data.id ?? commentId };
  }
}
