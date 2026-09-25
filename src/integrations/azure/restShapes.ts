import type { AreaPathTree } from '../../intake/placement.js';
import type {
  AzClosedPull,
  AzReviewer,
  AzPolicyEvaluation,
  AzPull,
  AzThread,
  AzTimelineRecord,
  AzWorkItem,
} from './azureDevOpsApi.js';
import { stripRef } from './sourceControl.js';
import { composeWorkItemBody } from './workItemBody.js';

// → docs/spec/15-integrations.md

export interface RawPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId?: string };
  createdBy?: { uniqueName?: string; displayName?: string };
  reviewers?: Array<{
    id?: string;
    displayName?: string;
    vote?: number;
    uniqueName?: string;
    isRequired?: boolean;
    isContainer?: boolean;
  }>;
}

export interface RawClosedPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  status?: string;
  closedDate?: string;
  createdBy?: { uniqueName?: string };
  reviewers?: RawPull['reviewers'];
  lastMergeCommit?: { commitId?: string };
}

export interface RawThread {
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

export interface RawWorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string }>;
}

export interface RawClassificationNode {
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

export interface RawWorkItemUpdate {
  revisedBy?: { uniqueName?: string };
  fields?: Record<string, { oldValue?: string; newValue?: string }>;
}

export interface RawTimelineRecord {
  type?: string;
  name?: string;
  result?: string | null;
  log?: { id?: number } | null;
  issues?: Array<{ type?: string; message?: string }>;
}

export interface RawPolicyEvaluation {
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

export function toPull(p: RawPull, url: string): AzPull {
  return {
    pullRequestId: p.pullRequestId,
    title: p.title,
    branch: stripRef(p.sourceRefName),
    baseBranch: stripRef(p.targetRefName),
    lastMergeSourceCommit: p.lastMergeSourceCommit?.commitId ?? '',
    authorUniqueName: p.createdBy?.uniqueName ?? '',
    authorDisplayName: p.createdBy?.displayName ?? '',
    url,
    isDraft: p.isDraft ?? false,
    mergeStatus: p.mergeStatus ?? 'notSet',
    reviewers: toReviewers(p.reviewers),
  };
}

function toReviewers(raw: RawPull['reviewers']): AzReviewer[] {
  return (raw ?? []).map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    ...(r.displayName ? { displayName: r.displayName } : {}),
    uniqueName: r.uniqueName ?? '',
    vote: r.vote ?? 0,
    isRequired: r.isRequired ?? false,
    isContainer: r.isContainer ?? false,
  }));
}

export function toClosedPull(p: RawClosedPull, closedAt: string, url: string): AzClosedPull {
  return {
    pullRequestId: p.pullRequestId,
    title: p.title,
    branch: stripRef(p.sourceRefName),
    baseBranch: stripRef(p.targetRefName),
    authorUniqueName: p.createdBy?.uniqueName ?? '',
    ...(p.reviewers === undefined ? {} : { reviewers: toReviewers(p.reviewers) }),
    url,
    merged: p.status === 'completed',
    closedAt,
    mergeCommitSha: p.status === 'completed' ? (p.lastMergeCommit?.commitId ?? null) : null,
  };
}

export function toThread(t: RawThread): AzThread {
  return {
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
  };
}

export function toPolicyEvaluation(e: RawPolicyEvaluation): AzPolicyEvaluation {
  return {
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
  };
}

export function toTimelineRecord(r: RawTimelineRecord): AzTimelineRecord {
  return {
    type: r.type ?? '',
    name: r.name ?? '',
    result: r.result ?? null,
    logId: r.log?.id ?? null,
    issues: (r.issues ?? []).map((i) => ({ type: i.type ?? '', message: i.message ?? '' })),
  };
}

export function toWorkItem(w: RawWorkItem, url: string): AzWorkItem {
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
    url,
  };
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

export function areaPaths(data: RawClassificationNode, project: string): AreaPathTree {
  const root = areaNodePath(data) ?? project;
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
