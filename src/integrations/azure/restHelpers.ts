import { withApiVersion, type AzureTransport } from './azureTransport.js';
import type { AzPullChanges } from './azureDevOpsApi.js';

// → docs/spec/15-integrations.md

export function headsRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
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
  changeEntries?: Array<{ item?: { path?: string; isFolder?: boolean } }>;
}

/**
 * What the latest iteration of a pull request changes, and the two commits it sits between: the
 * merge base and the head. `iterations` is that pull request's iterations URL.
 */
export async function readPullChanges(http: AzureTransport, iterations: string): Promise<AzPullChanges> {
  const listed = await http.request<{ value: AzIteration[] }>(withApiVersion(iterations));
  const latest = listed.value.reduce<AzIteration | null>((a, b) => ((b.id ?? 0) > (a?.id ?? 0) ? b : a), null);
  if (latest?.id === undefined) return { base: null, head: null, paths: [] };
  const changes = await http.request<AzIterationChanges>(withApiVersion(`${iterations}/${latest.id}/changes`));
  return {
    base: latest.commonRefCommit?.commitId ?? null,
    head: latest.sourceRefCommit?.commitId ?? null,
    paths: (changes.changeEntries ?? []).flatMap((c) =>
      c.item?.path === undefined || c.item.isFolder === true ? [] : [c.item.path.replace(/^\//, '')],
    ),
  };
}

/** A file's text at one commit; null where the file does not exist there. */
export async function readFileAtCommit(
  http: AzureTransport,
  repoUrl: string,
  path: string,
  commit: string,
): Promise<string | null> {
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
    if (/-> 404\b/.test((err as Error).message)) return null;
    throw err;
  }
}
