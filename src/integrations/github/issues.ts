import type { Store } from '../../store/store.js';
import type { Issue, IssueState } from '../../types.js';
import type { Capability, Integration, RefResolvable, WorldSlice } from '../integration.js';
import type { GhTimelineEvent, GitHubApi } from './githubApi.js';
import { githubRefUrl } from './refUrl.js';

export interface GitHubIssuesOpts {
  /** The GitHub client, already bound to a single owner/repo. */
  api: GitHubApi;
  store: Store;
  /** Only surface issues carrying this label. Unset = all open issues. */
  issueLabel?: string;
  /** Repo identity for building web URLs. When unset, ref resolution returns null. */
  owner?: string;
  repo?: string;
}

/**
 * The real `issues` provider: reads the tracker issues the harness resolves into
 * PRs from the GitHub Issues API. A drop-in for {@link FakeIssuesIntegration},
 * reading from the network instead of an injected fake world (so it is *not*
 * `Injectable`).
 */
export class GitHubIssuesIntegration implements Integration, RefResolvable {
  readonly id = 'issues:github';
  readonly capability: Capability = 'issues';

  private lastGood: Issue[] = [];

  constructor(private readonly opts: GitHubIssuesOpts) {}

  resolveRefUrl(ref: string): string | null {
    const { owner, repo } = this.opts;
    return owner && repo ? githubRefUrl(owner, repo, ref) : null;
  }

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, issueLabel } = this.opts;
      // The Issues API returns PRs as issues too — drop them; we only want real issues.
      const raw = (await api.listOpenIssues(issueLabel)).filter((i) => !i.isPullRequest);

      const issues = await Promise.all(
        raw.map(async (i): Promise<Issue> => {
          const timeline = await api.listIssueTimeline(i.number);
          return {
            id: `issue_${i.number}`,
            number: i.number,
            title: i.title,
            body: i.body,
            labels: i.labels,
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
