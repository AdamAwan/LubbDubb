import type { ErrorRecorder } from '../../errorLog.js';
import type {
  IssueCloseInput,
  IssueCommentInput,
  IssueCreateInput,
  IssueLabelInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { Issue, IssueState, TrackerItem } from '../../types.js';
import type {
  WorldCapability,
  Integration,
  IssueCloseCapable,
  IssueCommentCapable,
  IssueCreateCapable,
  IssueLabelCapable,
  RefResolvable,
  TicketHistoryCapable,
  WorldSlice,
} from '../integration.js';
import type { GhTimelineEvent, GitHubApi } from './githubApi.js';
import { HydrationCache } from '../hydrationCache.js';
import { hydrationMaxAgeMs, issueReadRef, type ReadPlan } from '../../world/readPlan.js';
import { githubRefUrl } from './refUrl.js';

/**
 * What the per-issue timeline read yields, held against the `updated_at` the
 * list payload reported when it was read. Everything else on an {@link Issue} —
 * title, body, labels, state, url — comes off the list payload, which is fetched
 * every pulse and so is never cached.
 *
 * `viewerOwnedLabels` is stored **unfiltered** by the issue's current labels: the
 * labels are fresh every pulse, so the intersection is taken at use rather than
 * baked in, and a cached ownership reading can never resurrect a label the issue
 * no longer carries.
 */
interface CachedIssueTimeline {
  /** The token this hydration is valid for. */
  updatedAt: string;
  linkedPrNumber: number | null;
  viewerOwnedLabels: string[];
}

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
  /** Injectable clock, so the hydration cache's expiry is testable without waiting for it. */
  now?: () => number;
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
    IssueCloseCapable,
    IssueCreateCapable,
    IssueCommentCapable,
    TicketHistoryCapable
{
  readonly id = 'issues:github';
  readonly capability: WorldCapability = 'issues';

  private lastGood: Issue[] | null = null;

  /**
   * Change-gated hydration of the per-issue timeline read, keyed by issue number.
   * **Not** a degradation path: a hit is a *current* reading GitHub's own list
   * payload says has not moved, so it never sets `stale`, which means the read
   * failed. → {@link HydrationCache}
   */
  private readonly timelineCache: HydrationCache<CachedIssueTimeline>;

  constructor(private readonly opts: GitHubIssuesOpts) {
    this.timelineCache = new HydrationCache(opts.now);
  }

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

  /** The outbound side of the cockpit's watch/ignore toggle. PRs and issues share the labels API. */
  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    await this.opts.api.setIssueLabel(input.number, input.label, input.present);
    return { ok: true };
  }

  /**
   * Close the issue — the plan back-out's tracker half. The operator's words are a
   * comment written beside it rather than anything smuggled in here: GitHub's own
   * vocabulary for *why* an issue closed is the two `state_reason` words, and
   * `not_planned` is the one that reads as "we are not doing this" on the timeline.
   */
  async closeIssue(input: IssueCloseInput): Promise<SendResult> {
    await this.opts.api.closeIssue(input.number, input.reason);
    return { ok: true, ref: `issue:${input.number}` };
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

  async snapshot(plan?: ReadPlan): Promise<WorldSlice> {
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
          const cached = await this.issueTimeline(
            i.number,
            i.updatedAt,
            viewer,
            hydrationMaxAgeMs(plan, issueReadRef(i.number)),
          );
          const tracksOwner = viewer !== null && ownershipLabel !== undefined && i.labels.includes(ownershipLabel);
          return {
            id: `issue_${i.number}`,
            number: i.number,
            title: i.title,
            body: i.body,
            labels: i.labels,
            // Intersected with *this pulse's* labels, never the ones the timeline
            // was read beside: the gate that decides whether anything is picked up
            // must not be able to name a label the issue has since lost.
            ...(tracksOwner
              ? { labelsAddedByViewer: i.labels.filter((l) => cached.viewerOwnedLabels.includes(l)) }
              : {}),
            state: normalizeState(i.state),
            linkedPrNumber: cached.linkedPrNumber,
            url: i.url,
          };
        }),
      );

      // An issue that has left the open set is never hydrated again from here.
      this.timelineCache.retain(raw.map((i) => i.number));

      this.lastGood = issues;
      return { issues };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      // No successful read yet — nothing to degrade to. An empty slice would make
      // every watched issue look gone; fail the pulse instead.
      if (this.lastGood === null) throw err;
      return { issues: this.lastGood, stale: true };
    }
  }

  /**
   * The issue's timeline read, or the last one when GitHub's `updated_at` says
   * nothing has happened to the issue since.
   *
   * The token covers what the timeline is read *for*: a label added or removed
   * and a comment all bump `updated_at`, so tag authorship — which gates pickup
   * fleet-wide ([06](../../../docs/spec/06-issue-pickup.md)) — can only go stale
   * behind an event that moves it. What it does not cover is a cross-reference
   * created from *elsewhere* (a pull request naming `#n`), which is why the cache
   * expires entries rather than trusting one forever — after `maxAgeMs`, which is
   * what this issue's [lane](../../world/readPlan.ts) allows it, and which is
   * therefore how far behind `linkedPrNumber` can ever be.
   */
  private async issueTimeline(
    number: number,
    updatedAt: string,
    viewer: string | null,
    maxAgeMs: number,
  ): Promise<CachedIssueTimeline> {
    const cached = this.timelineCache.get(number, maxAgeMs);
    if (cached !== undefined && cached.updatedAt === updatedAt) return cached;

    const timeline = await this.opts.api.listIssueTimeline(number);
    const fresh: CachedIssueTimeline = {
      updatedAt,
      linkedPrNumber: linkedPrFromTimeline(timeline),
      // Resolved whether or not the gate is on: turning `ownershipLabel` on is a
      // restart, so there is no run in which this is computed too late, and it
      // costs nothing but the fold over events already in hand.
      viewerOwnedLabels: viewer === null ? [] : labelsOwnedBy(timeline, viewer),
    };
    this.timelineCache.set(number, fresh);
    return fresh;
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
  const owned = labelsOwnedBy(events, viewer);
  return currentLabels.filter((l) => owned.includes(l));
}

/**
 * The labels whose most recent `labeled` event names `viewer`, with no filter
 * against what the issue carries now.
 *
 * Split out of {@link viewerAddedLabels} because the two halves have different
 * lifetimes: this one is derived from the timeline and cached with it, while the
 * current-label filter reads a list payload fetched every pulse.
 */
function labelsOwnedBy(events: GhTimelineEvent[], viewer: string): string[] {
  const owner = new Map<string, string>();
  for (const ev of events) {
    if (ev.label === null) continue;
    if (ev.event === 'labeled') owner.set(ev.label, ev.actorLogin ?? '');
    else if (ev.event === 'unlabeled') owner.delete(ev.label);
  }
  return [...owner.entries()].filter(([, actor]) => actor === viewer).map(([label]) => label);
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
