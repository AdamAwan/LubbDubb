import type { Store } from '../../store/store.js';
import type { Issue, IssueState } from '../../types.js';
import type { Capability, Integration, WorldSlice } from '../integration.js';
import type { AzureDevOpsApi } from './azureDevOpsApi.js';

export interface AzureWorkItemsOpts {
  /** The Azure DevOps client, already bound to a single organization/project. */
  api: AzureDevOpsApi;
  store: Store;
  /** Only surface work items carrying this tag. Unset = all open work items. */
  workItemTag?: string;
}

/**
 * The real `issues` provider for Azure DevOps: reads the work items the harness
 * resolves into PRs from the Azure Boards / Work Item Tracking API. A drop-in for
 * {@link GitHubIssuesIntegration}, reading from the network instead of an injected
 * fake world (so it is *not* `Injectable`). Work-item tags map onto issue
 * `labels`, so the provider-agnostic pickup/priority gates work unchanged.
 */
export class AzureDevOpsWorkItemsIntegration implements Integration {
  readonly id = 'issues:azure';
  readonly capability: Capability = 'issues';

  private lastGood: Issue[] = [];

  constructor(private readonly opts: AzureWorkItemsOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, workItemTag } = this.opts;
      const raw = await api.listOpenWorkItems(workItemTag);
      const issues = raw.map(
        (w): Issue => ({
          id: `issue_${w.id}`,
          number: w.id,
          title: w.title,
          body: w.body,
          labels: w.tags,
          state: normalizeState(w.state),
          linkedPrNumber: linkedPrFromRelations(w.relationUrls),
          url: w.url,
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
