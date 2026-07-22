import type { Store } from '../../store/store.js';
import type { SendResult, WorkItemStateInput } from '../../sink/actionSink.js';
import type { Issue, IssueState } from '../../types.js';
import type { Capability, Integration, WorkItemStateCapable, WorldSlice } from '../integration.js';
import type { AzureDevOpsApi, AzWorkItemUpdate } from './azureDevOpsApi.js';

export interface AzureWorkItemsOpts {
  /** The Azure DevOps client, already bound to a single organization/project. */
  api: AzureDevOpsApi;
  store: Store;
  /** Only surface work items carrying this tag. Unset = all open work items. */
  workItemTag?: string;
  /**
   * When set, resolve tag authorship for work items carrying this tag and expose the
   * viewer-added subset as `labelsAddedByViewer`, so the dispatcher's ownership gate
   * (`issuePickupRequireOwnLabel`) can ignore a tag a third party added. Unset =
   * don't track authorship (no per-item revision fetch). Keyed on the tag so the
   * extra `listWorkItemUpdates` call only fires for items that actually carry it.
   */
  ownershipTag?: string;
}

/**
 * The real `issues` provider for Azure DevOps: reads the work items the harness
 * resolves into PRs from the Azure Boards / Work Item Tracking API. A drop-in for
 * {@link GitHubIssuesIntegration}, reading from the network instead of an injected
 * fake world (so it is *not* `Injectable`). Work-item tags map onto issue
 * `labels`, so the provider-agnostic pickup/priority gates work unchanged.
 */
export class AzureDevOpsWorkItemsIntegration implements Integration, WorkItemStateCapable {
  readonly id = 'issues:azure';
  readonly capability: Capability = 'issues';

  private lastGood: Issue[] = [];

  constructor(private readonly opts: AzureWorkItemsOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, workItemTag, ownershipTag } = this.opts;
      const raw = await api.listOpenWorkItems(workItemTag);
      const viewer = ownershipTag ? await api.viewerUniqueName() : null;
      const issues = await Promise.all(
        raw.map(async (w): Promise<Issue> => {
          // Only pay the per-item revision fetch when the ownership gate is on and
          // the item actually carries the gate tag — others can't be picked up anyway.
          const tracksOwner = viewer !== null && ownershipTag !== undefined && w.tags.includes(ownershipTag);
          const labelsAddedByViewer = tracksOwner
            ? [...viewerAddedTags(await api.listWorkItemUpdates(w.id), viewer)]
            : undefined;
          return {
            id: `issue_${w.id}`,
            number: w.id,
            title: w.title,
            body: w.body,
            labels: w.tags,
            ...(labelsAddedByViewer ? { labelsAddedByViewer } : {}),
            state: normalizeState(w.state),
            // Preserve the raw System.State alongside the open/closed collapse so the
            // dispatcher's state-based pickup gate and "in review" back-off can see it.
            workItemState: w.state,
            linkedPrNumber: linkedPrFromRelations(w.relationUrls),
            url: w.url,
          };
        }),
      );
      this.lastGood = issues;
      return { issues };
    } catch (err) {
      this.opts.store.recordConnectorEvent('azure_snapshot_error', {
        capability: this.capability,
        message: (err as Error).message,
      });
      return { issues: this.lastGood };
    }
  }

  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    await this.opts.api.setWorkItemState(input.number, input.state);
    this.opts.store.recordConnectorEvent('work_item_state_set', { ...input });
    return { ok: true };
  }
}

/** Split Azure's semicolon-delimited System.Tags string into a trimmed, non-empty list. */
export function parseTags(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/**
 * Which tags the viewer added, folded from a work item's revision updates. Each
 * update carries System.Tags before/after that revision; a tag in `tagsNew` but not
 * `tagsOld` was added by that revision's author. Later revisions win: a tag re-added
 * by someone else transfers ownership away, a removal clears it. A revision that
 * didn't touch tags (no System.Tags diff) leaves ownership untouched. Pure —
 * unit-testable without the network.
 */
export function viewerAddedTags(updates: AzWorkItemUpdate[], viewer: string): Set<string> {
  const owned = new Set<string>();
  for (const u of updates) {
    const before = new Set(parseTags(u.tagsOld));
    const after = parseTags(u.tagsNew);
    const afterSet = new Set(after);
    for (const tag of after) {
      if (before.has(tag)) continue; // unchanged this revision
      if (u.revisedByUniqueName === viewer) owned.add(tag);
      else owned.delete(tag); // added by someone else — not yours
    }
    for (const tag of before) {
      if (!afterSet.has(tag)) owned.delete(tag); // removed this revision
    }
  }
  return owned;
}

/** Azure work-item states that mean "done" — everything else is treated as open. */
const CLOSED_STATES: ReadonlySet<string> = new Set(['Closed', 'Done', 'Removed', 'Resolved']);

export function normalizeState(state: string): IssueState {
  return CLOSED_STATES.has(state) ? 'closed' : 'open';
}

/**
 * The PR that resolves a work item, read from its ArtifactLink relations: Azure
 * links a PR as `vstfs:///Git/PullRequestId/{project}%2F{repoId}%2F{prId}`. The
 * trailing segment is the PR id. Returns the most recently listed link, or `null`
 * when nothing links a PR. Pure so it stays unit-testable without the network.
 */
export function linkedPrFromRelations(relationUrls: string[]): number | null {
  let linked: number | null = null;
  for (const url of relationUrls) {
    const match = /\/Git\/PullRequestId\/.*(?:%2F|\/)(\d+)$/i.exec(url);
    if (match) linked = Number(match[1]);
  }
  return linked;
}
