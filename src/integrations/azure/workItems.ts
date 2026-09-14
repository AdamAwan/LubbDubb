import { issueOriginRef } from '../../issueOrigins.js';
import type { ErrorRecorder } from '../../errorLog.js';
import type {
  IssueCommentInput,
  IssueCreateInput,
  IssueLabelInput,
  SendResult,
  WorkItemAreaPathInput,
  WorkItemLinkInput,
  WorkItemParentInput,
  WorkItemStateInput,
} from '../../sink/actionSink.js';
import type { Issue, IssueRelative, IssueState, TrackerItem } from '../../types.js';
import type { AreaPathTree } from '../../intake/placement.js';
import type {
  WorldCapability,
  Integration,
  IssueCommentCapable,
  IssueCreateCapable,
  IssueLabelCapable,
  RefResolvable,
  TicketHistoryCapable,
  WorkItemLinkCapable,
  AreaPathCapable,
  WorkItemPlacementCapable,
  WorkItemStateCapable,
  WorldSlice,
} from '../integration.js';
import type { AzureDevOpsApi, AzWorkItem, AzWorkItemUpdate } from './azureDevOpsApi.js';
import { azureRefUrl } from './refUrl.js';
import { HydrationCache } from '../hydrationCache.js';
import { hydrationMaxAgeMs, issueReadRef, type ReadPlan } from '../../world/readPlan.js';

// → docs/spec/15-integrations.md

interface AzureWorkItemsOpts {
  api: AzureDevOpsApi;
  errors?: ErrorRecorder;
  organization?: string;
  project?: string;
  repository?: string;
  workItemTag?: string;
  assignedTo?: string;
  ownershipTag?: string;
}

export class AzureDevOpsWorkItemsIntegration
  implements
    Integration,
    RefResolvable,
    WorkItemStateCapable,
    WorkItemLinkCapable,
    WorkItemPlacementCapable,
    AreaPathCapable,
    IssueLabelCapable,
    IssueCreateCapable,
    IssueCommentCapable,
    TicketHistoryCapable
{
  readonly id = 'issues:azure';
  readonly capability: WorldCapability = 'issues';
  readonly bodyFormat = 'html' as const;

  private lastGood: Issue[] | null = null;
  private readonly tagAuthorship = new HydrationCache<{ token: string; tags: string[] }>();

  constructor(private readonly opts: AzureWorkItemsOpts) {}

  resolveRefUrl(ref: string): string | null {
    const { organization, project, repository } = this.opts;
    return organization && project && repository ? azureRefUrl(organization, project, repository, ref) : null;
  }

  async listTicketHistory(since: string): Promise<TrackerItem[]> {
    const { api, workItemTag, assignedTo } = this.opts;
    const raw = await api.listWorkItemsChangedSince(since, workItemTag, assignedTo);
    return raw.map((w) => ({
      number: w.id,
      title: w.title,
      labels: w.tags,
      state: normalizeState(w.state),
      workItemState: w.state,
      url: w.url,
      createdAt: w.createdAt,
      changedAt: w.changedAt,
    }));
  }

  async snapshot(plan?: ReadPlan): Promise<WorldSlice> {
    try {
      const { api, workItemTag, assignedTo, ownershipTag } = this.opts;
      const raw = await api.listOpenWorkItems(workItemTag, assignedTo);
      const viewer = ownershipTag ? await api.viewerUniqueName() : null;
      const hierarchy = await this.hydrateHierarchy(raw);
      const issues = await Promise.all(
        raw.map(async (w): Promise<Issue> => {
          const tracksOwner = viewer !== null && ownershipTag !== undefined && w.tags.includes(ownershipTag);
          const labelsAddedByViewer = tracksOwner
            ? await this.viewerAddedTagsFor(w, viewer, hydrationMaxAgeMs(plan, issueReadRef(w.id)))
            : undefined;
          return {
            id: `issue_${w.id}`,
            number: w.id,
            title: w.title,
            body: w.body,
            labels: w.tags,
            ...(labelsAddedByViewer ? { labelsAddedByViewer } : {}),
            state: normalizeState(w.state),
            issueType: w.workItemType,
            areaPath: w.areaPath,
            ...hierarchy(w),
            workItemState: w.state,
            linkedPrNumber: linkedPrFromRelations(w.relationUrls),
            url: w.url,
          };
        }),
      );
      this.tagAuthorship.retain(raw.map((w) => w.id));
      this.lastGood = issues;
      return { issues };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      if (this.lastGood === null) throw err;
      return { issues: this.lastGood, stale: true };
    }
  }

  private async viewerAddedTagsFor(w: AzWorkItem, viewer: string, maxAgeMs: number): Promise<string[]> {
    const token = `${viewer}\u0000${w.changedAt}`;
    if (w.changedAt !== '') {
      const hit = this.tagAuthorship.get(w.id, maxAgeMs);
      if (hit !== undefined && hit.token === token) return [...hit.tags];
    }
    const tags = [...viewerAddedTags(await this.opts.api.listWorkItemUpdates(w.id), viewer)];
    if (w.changedAt !== '') this.tagAuthorship.set(w.id, { token, tags });
    return tags;
  }

  private async hydrateHierarchy(raw: AzWorkItem[]): Promise<(w: AzWorkItem) => Partial<Issue>> {
    const none = (): Partial<Issue> => ({});
    try {
      const listed = new Map(raw.map((w) => [w.id, w]));
      const known = new Map(listed);
      const wanted = new Set<number>();
      for (const w of raw) {
        if (w.parentId !== null) wanted.add(w.parentId);
        for (const id of w.childIds) wanted.add(id);
        for (const id of w.dependsOnIds) wanted.add(id);
      }
      for (const w of await this.fetch([...wanted], known)) known.set(w.id, w);

      const siblings = new Set<number>();
      for (const w of raw) {
        const parent = w.parentId === null ? undefined : known.get(w.parentId);
        for (const id of parent?.childIds ?? []) if (id !== w.id) siblings.add(id);
      }
      for (const w of await this.fetch([...siblings], known)) known.set(w.id, w);

      return (w: AzWorkItem): Partial<Issue> => {
        const parent = w.parentId === null ? null : (known.get(w.parentId) ?? null);
        if (w.parentId !== null && parent === null) {
          return { children: relatives(w.childIds, known), dependsOn: relatives(w.dependsOnIds, known) };
        }
        return {
          parent: parent === null ? null : relative(parent, { withBody: true }),
          children: relatives(w.childIds, known),
          dependsOn: relatives(w.dependsOnIds, known),
          ...(parent === null
            ? {}
            : {
                siblings: relatives(
                  parent.childIds.filter((id) => id !== w.id),
                  known,
                ),
              }),
        };
      };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} relation hydration failed: ${(err as Error).message}`,
      });
      return none;
    }
  }

  private async fetch(ids: number[], known: Map<number, AzWorkItem>): Promise<AzWorkItem[]> {
    const missing = ids.filter((id) => !known.has(id));
    return missing.length === 0 ? [] : this.opts.api.getWorkItems(missing);
  }

  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    await this.opts.api.setWorkItemState(input.number, input.state);
    return { ok: true };
  }

  async linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    await this.opts.api.linkWorkItemToPull(input.number, input.prNumber);
    return { ok: true, ref: `#${input.number} -> PR ${input.prNumber}` };
  }

  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const existing = input.commentRef === null ? null : Number(input.commentRef);
    const ref =
      existing !== null && Number.isInteger(existing)
        ? await this.opts.api.updateWorkItemComment(input.number, existing, input.body)
        : await this.opts.api.createWorkItemComment(input.number, input.body);
    return { ok: true, ref: String(ref.id) };
  }

  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    const created = await this.opts.api.createWorkItem({
      type: input.type ?? 'Task',
      title: input.title,
      description: input.body,
      tags: input.labels,
      assignedTo: input.assignee,
    });
    const ref = issueOriginRef('root', created.id);
    if (input.relatedTo !== null) {
      try {
        await this.opts.api.relateWorkItem(created.id, input.relatedTo);
      } catch (err) {
        throw new Error(
          `work item ${created.id} was created but linking it to #${input.relatedTo} failed: ${(err as Error).message}`,
        );
      }
    }
    return { ok: true, ref };
  }

  async listAreaPaths(): Promise<AreaPathTree> {
    return this.opts.api.listAreaPaths();
  }

  async setWorkItemParent(input: WorkItemParentInput): Promise<SendResult> {
    await this.opts.api.setWorkItemParent(input.number, input.parentNumber);
    return { ok: true, ref: `#${input.number} -> #${input.parentNumber}` };
  }

  async setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult> {
    await this.opts.api.setWorkItemAreaPath(input.number, input.areaPath);
    return { ok: true, ref: input.areaPath };
  }

  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    await this.opts.api.setWorkItemTag(input.number, input.label, input.present);
    return { ok: true };
  }
}

function relative(w: AzWorkItem, opts: { withBody: boolean } = { withBody: false }): IssueRelative {
  return {
    number: w.id,
    title: w.title,
    issueType: w.workItemType,
    workItemState: w.state,
    state: normalizeState(w.state),
    ...(opts.withBody ? { body: w.body } : {}),
    url: w.url,
  };
}

function relatives(ids: number[], known: Map<number, AzWorkItem>): IssueRelative[] {
  const out: IssueRelative[] = [];
  for (const id of ids) {
    const w = known.get(id);
    if (w) out.push(relative(w));
  }
  return out;
}

export function parseTags(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

export function viewerAddedTags(updates: AzWorkItemUpdate[], viewer: string): Set<string> {
  const owned = new Set<string>();
  for (const u of updates) {
    const before = new Set(parseTags(u.tagsOld));
    const after = parseTags(u.tagsNew);
    const afterSet = new Set(after);
    for (const tag of after) {
      if (before.has(tag)) continue;
      if (u.revisedByUniqueName === viewer) owned.add(tag);
      else owned.delete(tag);
    }
    for (const tag of before) {
      if (!afterSet.has(tag)) owned.delete(tag);
    }
  }
  return owned;
}

const CLOSED_STATES: ReadonlySet<string> = new Set(['Closed', 'Done', 'Removed', 'Resolved']);

export function normalizeState(state: string): IssueState {
  return CLOSED_STATES.has(state) ? 'closed' : 'open';
}

export function linkedPrFromRelations(relationUrls: string[]): number | null {
  let linked: number | null = null;
  for (const url of relationUrls) {
    const match = /\/Git\/PullRequestId\/.*(?:%2F|\/)(\d+)$/i.exec(url);
    if (match) linked = Number(match[1]);
  }
  return linked;
}
