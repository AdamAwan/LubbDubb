import { withApiVersion, type AzureTransport } from './azureTransport.js';
import type { AzPullChanges } from './azureDevOpsApi.js';

// → docs/spec/15-integrations.md

export function headsRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

export function pullReviewerUrl(repoUrl: string, pullRequestId: number, reviewerId: string): string {
  return withApiVersion(`${repoUrl}/pullrequests/${pullRequestId}/reviewers/${encodeURIComponent(reviewerId)}`);
}

export function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export function tagWriteOp(
  current: readonly string[],
  tags: readonly string[],
): { op: string; path: string; value?: string } {
  const path = '/fields/System.Tags';
  if (tags.length === 0) return { op: 'remove', path };
  if (current.length === 0) return { op: 'add', path, value: tags.join('; ') };
  return { op: 'replace', path, value: tags.join('; ') };
}

export function sameTag(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

interface AzIteration {
  id?: number;
  sourceRefCommit?: { commitId?: string };
  commonRefCommit?: { commitId?: string };
}

interface AzIterationChanges {
  changeEntries?: Array<{
    item?: { path?: string; isFolder?: boolean };
    originalPath?: string;
    sourceServerItem?: string;
  }>;
}

/**
 * What the latest iteration of a pull request changes, and the two commits it sits between: the
 * merge base and the head. `iterations` is that pull request's iterations URL.
 */
export async function readPullChanges(http: AzureTransport, iterations: string): Promise<AzPullChanges> {
  const listed = await http.request<{ value: AzIteration[] }>(withApiVersion(iterations));
  const newest = Math.max(0, ...listed.value.map((i) => i.id ?? 0));
  const latest = listed.value.find((i) => i.id === newest);
  if (latest === undefined) return { base: null, head: null, files: [] };
  const changes = await http.request<AzIterationChanges>(withApiVersion(`${iterations}/${newest}/changes`));
  return {
    base: latest.commonRefCommit?.commitId ?? null,
    head: latest.sourceRefCommit?.commitId ?? null,
    files: (changes.changeEntries ?? []).flatMap((c) => {
      if (c.item?.path === undefined || c.item.isFolder === true) return [];
      const from = c.originalPath ?? c.sourceServerItem;
      return [{ path: repoPath(c.item.path), from: from === undefined ? null : repoPath(from) }];
    }),
  };
}

function repoPath(path: string): string {
  return path.replace(/^\//, '');
}

function isAzNotFound(err: unknown): boolean {
  return /-> 404\b/.test((err as Error).message);
}

/** A file's text at one commit; empty where the file does not exist there, which is what a diff wants. */
export async function readFileAtCommit(
  http: AzureTransport,
  repoUrl: string,
  path: string,
  commit: string,
): Promise<string> {
  const url = withApiVersion(`${repoUrl}/items`, {
    path: `/${path}`,
    'versionDescriptor.versionType': 'commit',
    'versionDescriptor.version': commit,
    includeContent: 'true',
  });
  try {
    const item = await http.request<{ content?: string }>(url, {}, { conditional: false });
    return item.content ?? '';
  } catch (err) {
    if (isAzNotFound(err)) return '';
    throw err;
  }
}
