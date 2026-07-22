import type { Store } from '../../store/store.js';
import type { Issue, IssueState } from '../../types.js';
import type { Capability, Integration, WorldSlice } from '../integration.js';
import type { GhTimelineEvent, GitHubApi } from './githubApi.js';

export interface GitHubIssuesOpts {
  /** The GitHub client, already bound to a single owner/repo. */
  api: GitHubApi;
  store: Store;
  /** Only surface issues carrying this label. Unset = all open issues. */
  issueLabel?: string;
  /**
   * When set, resolve tag authorship for issues carrying this label and expose the
   * viewer-added subset as `labelsAddedByViewer`, so the dispatcher's ownership gate
   * (`issuePickupRequireOwnLabel`) can ignore a label a third party added. Unset =
   * don't track authorship (the timeline is still read for linked-PR detection).
   */
  ownershipLabel?: string;
}

/**
 * The real `issues` provider: reads the tracker issues the harness resolves into
 * PRs from the GitHub Issues API. A drop-in for {@link FakeIssuesIntegration},
 * reading from the network instead of an injected fake world (so it is *not*
 * `Injectable`).
 */
export class GitHubIssuesIntegration implements Integration {
  readonly id = 'issues:github';
  readonly capability: Capability = 'issues';

  private lastGood: Issue[] = [];

  constructor(private readonly opts: GitHubIssuesOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, issueLabel, ownershipLabel } = this.opts;
      // The Issues API returns PRs as issues too — drop them; we only want real issues.
      const raw = (await api.listOpenIssues(issueLabel)).filter((i) => !i.isPullRequest);
      // The timeline is already fetched per issue for linked-PR detection, so tag
      // authorship costs only one cached viewer lookup — do it only when the
      // ownership gate is on, and only for issues actually carrying the gate label.
      const viewer = ownershipLabel ? await api.viewerLogin() : null;

      const issues = await Promise.all(
        raw.map(async (i): Promise<Issue> => {
          const timeline = await api.listIssueTimeline(i.number);
          const tracksOwner = viewer !== null && ownershipLabel !== undefined && i.labels.includes(ownershipLabel);
          return {
            id: `issue_${i.number}`,
            number: i.number,
            title: i.title,
            body: i.body,
            labels: i.labels,
            ...(tracksOwner ? { labelsAddedByViewer: viewerAddedLabels(timeline, viewer, i.labels) } : {}),
            state: normalizeState(i.state),
            linkedPrNumber: linkedPrFromTimeline(timeline),
            url: i.url,
          };
        }),
      );

      this.lastGood = issues;
      return { issues };
    } catch (err) {
      this.opts.store.recordConnectorEvent('github_snapshot_error', {
        capability: this.capability,
        message: (err as Error).message,
      });
      return { issues: this.lastGood };
    }
  }
}

function normalizeState(state: string): IssueState {
  return state === 'closed' ? 'closed' : 'open';
}

/**
 * Which of an issue's *current* labels the authenticated viewer added, from its
 * `labeled`/`unlabeled` timeline events. A label's owner is whoever most recently
 * added it — a later re-add by someone else transfers ownership, a removal clears
 * it. Filtered to labels the issue still carries, so a stale timeline entry can't
 * leak a since-removed label. Pure — unit-testable without the network.
 */
export function viewerAddedLabels(events: GhTimelineEvent[], viewer: string, currentLabels: string[]): string[] {
  const owner = new Map<string, string>();
  for (const ev of events) {
    if (ev.label === null) continue;
    if (ev.event === 'labeled') owner.set(ev.label, ev.actorLogin ?? '');
    else if (ev.event === 'unlabeled') owner.delete(ev.label);
  }
  return currentLabels.filter((l) => owner.get(l) === viewer);
}

/**
 * The PR that resolves an issue, read from its timeline: the most recent
 * cross-reference / connection whose source is a PR. `null` when nothing links a PR.
 */
export function linkedPrFromTimeline(events: GhTimelineEvent[]): number | null {
  let linked: number | null = null;
  for (const event of events) {
    if (event.sourcePrNumber !== null) linked = event.sourcePrNumber;
  }
  return linked;
}
