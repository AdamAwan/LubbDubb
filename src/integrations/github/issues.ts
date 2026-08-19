import type { ErrorRecorder } from '../../errorLog.js';
import type {
  FilingTarget,
  IssueCommentInput,
  IssueCreateInput,
  IssueLabelInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { Issue, IssueState, TrackerItem } from '../../types.js';
import type {
  Capability,
  Integration,
  IssueCommentCapable,
  IssueCreateCapable,
  IssueLabelCapable,
  RefResolvable,
  TicketHistoryCapable,
  WorldSlice,
} from '../integration.js';
import type { GhTimelineEvent, GitHubApi } from './githubApi.js';
import { githubRefUrl } from './refUrl.js';

interface GitHubIssuesOpts {
  /** The GitHub client, already bound to a single owner/repo. */
  api: GitHubApi;
  /** Central error sink: snapshot failures surface in the cockpit's Errors panel. */
  errors?: ErrorRecorder;
  /** Repo identity for building web URLs. When unset, ref resolution returns null. */
  owner?: string;
  repo?: string;
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
export class GitHubIssuesIntegration
  implements
    Integration,
    RefResolvable,
    IssueLabelCapable,
    IssueCreateCapable,
    IssueCommentCapable,
    TicketHistoryCapable
{
  readonly id = 'issues:github';
  readonly capability: Capability = 'issues';

  private lastGood: Issue[] = [];

  constructor(private readonly opts: GitHubIssuesOpts) {}

  resolveRefUrl(ref: string): string | null {
    const { owner, repo } = this.opts;
    return owner && repo ? githubRefUrl(owner, repo, ref) : null;
  }

  /**
   * The mirror's read: every issue GitHub has seen change since `since`, in either
   * state (issue #329).
   *
   * Narrowed by nothing, exactly as {@link snapshot} narrows by nothing — the two
   * must return the same population or the tab and the world disagree about which
   * tickets exist. GitHub has no issue-side assignee filter in this codebase
   * (`defaultAssignee` is documented as not one), so on this provider "the
   * assignment filter" is the whole repository, and that is the honest answer
   * rather than a second, quieter filter invented here.
   *
   * No timeline read, unlike the snapshot: a history row carries no linked PR, so
   * a sweep costs its pages and nothing per item. That is the difference between a
   * month of backfill being one request per hundred items and being one per item.
   */
  async listTicketHistory(since: string): Promise<TrackerItem[]> {
    const raw = await this.opts.api.listIssuesChangedSince(since);
    return raw
      .filter((i) => !i.isPullRequest)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels,
        state: normalizeState(i.state),
        // GitHub has no workflow states beyond open/closed, and null is what says
        // so: the tab draws no state tier at all where every row answers null.
        workItemState: null,
        url: i.url,
        createdAt: i.createdAt,
        changedAt: i.updatedAt,
      }));
  }

  /**
   * File a new issue (issue #394).
   *
   * Two of {@link IssueCreateInput}'s fields are answered in GitHub's own
   * vocabulary rather than dropped:
   *
   * - **`type` is dropped.** A GitHub issue is not created *as* anything; the
   *   caller's opinion about a work item type has no expression here and inventing
   *   a label for it would put a tag on the repository nobody asked for.
   * - **`relatedTo` becomes a cross-reference.** Naming `#<n>` in the body is what
   *   makes GitHub draw the edge, and it draws it on *both* issues — the closest
   *   thing GitHub has to Azure's `related` link. Appended rather than left to the
   *   caller so a body composed once files correctly into either tracker.
   */
  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    const body = input.relatedTo === null ? input.body : `${input.body}\n\nRelated to #${input.relatedTo}.`;
    const created = await this.opts.api.createIssue({
      title: input.title,
      body,
      labels: input.labels,
      assignee: input.assignee,
    });
    return { ok: true, ref: `issue:${created.number}` };
  }

  /**
   * Where a filing would land and as whom (issue #413).
   *
   * `viewerLogin()` is the probe rather than a call invented for it: it is one
   * authenticated round trip that a revoked or expired `GITHUB_TOKEN` fails
   * outright, which is the only thing about filing that boot cannot already prove.
   * Owner and repo come from the same opts ref resolution uses, so the name the
   * cockpit shows is the repository links go to.
   */
  async describeFilingTarget(): Promise<FilingTarget> {
    const identity = await this.opts.api.viewerLogin();
    const { owner, repo } = this.opts;
    return { target: owner && repo ? `${owner}/${repo}` : 'an unnamed GitHub repository', identity };
  }

  /** The outbound side of the cockpit's watch/ignore toggle. PRs and issues share the labels API. */
  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    await this.opts.api.setIssueLabel(input.number, input.label, input.present);
    return { ok: true };
  }

  /**
   * The plan's status comment: created once, then edited in place by the id the
   * create returned — so an issue accumulates one living status comment, not a
   * stream of them.
   */
  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const existing = input.commentRef === null ? null : Number(input.commentRef);
    const ref =
      existing !== null && Number.isInteger(existing)
        ? await this.opts.api.updateIssueComment(existing, input.body)
        : await this.opts.api.createIssueComment(input.number, input.body);
    return { ok: true, ref: String(ref.id) };
  }

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, ownershipLabel } = this.opts;
      // Fetch every open issue so all of them display in the cockpit; the dispatcher's
      // opt-in watch gate (not an ingest filter) decides which are worked.
      // The Issues API returns PRs as issues too — drop them; we only want real issues.
      const raw = (await api.listOpenIssues()).filter((i) => !i.isPullRequest);
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
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      return { issues: this.lastGood, stale: true };
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
