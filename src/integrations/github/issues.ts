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

// → docs/spec/15-integrations.md

interface CachedIssueTimeline {
  updatedAt: string;
  linkedPrNumber: number | null;
  viewerOwnedLabels: string[];
}

interface GitHubIssuesOpts {
  api: GitHubApi;
  errors?: ErrorRecorder;
  owner?: string;
  repo?: string;
  ownershipLabel?: string;
  now?: () => number;
}

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

  private readonly timelineCache: HydrationCache<CachedIssueTimeline>;

  constructor(private readonly opts: GitHubIssuesOpts) {
    this.timelineCache = new HydrationCache(opts.now);
  }

  resolveRefUrl(ref: string): string | null {
    const { owner, repo } = this.opts;
    return owner && repo ? githubRefUrl(owner, repo, ref) : null;
  }

  async listTicketHistory(since: string): Promise<TrackerItem[]> {
    const raw = await this.opts.api.listIssuesChangedSince(since);
    return raw
      .filter((i) => !i.isPullRequest)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels,
        state: normalizeState(i.state),
        workItemState: null,
        url: i.url,
        createdAt: i.createdAt,
        changedAt: i.updatedAt,
      }));
  }

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

  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    await this.opts.api.setIssueLabel(input.number, input.label, input.present);
    return { ok: true };
  }

  async closeIssue(input: IssueCloseInput): Promise<SendResult> {
    await this.opts.api.closeIssue(input.number, input.reason);
    return { ok: true, ref: `issue:${input.number}` };
  }

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
      const raw = (await api.listOpenIssues()).filter((i) => !i.isPullRequest);
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
            ...(tracksOwner
              ? { labelsAddedByViewer: i.labels.filter((l) => cached.viewerOwnedLabels.includes(l)) }
              : {}),
            state: normalizeState(i.state),
            linkedPrNumber: cached.linkedPrNumber,
            url: i.url,
          };
        }),
      );

      this.timelineCache.retain(raw.map((i) => i.number));

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
      viewerOwnedLabels: viewer === null ? [] : labelsOwnedBy(timeline, viewer),
    };
    this.timelineCache.set(number, fresh);
    return fresh;
  }
}

function normalizeState(state: string): IssueState {
  return state === 'closed' ? 'closed' : 'open';
}

export function viewerAddedLabels(events: GhTimelineEvent[], viewer: string, currentLabels: string[]): string[] {
  const owned = labelsOwnedBy(events, viewer);
  return currentLabels.filter((l) => owned.includes(l));
}

function labelsOwnedBy(events: GhTimelineEvent[], viewer: string): string[] {
  const owner = new Map<string, string>();
  for (const ev of events) {
    if (ev.label === null) continue;
    if (ev.event === 'labeled') owner.set(ev.label, ev.actorLogin ?? '');
    else if (ev.event === 'unlabeled') owner.delete(ev.label);
  }
  return [...owner.entries()].filter(([, actor]) => actor === viewer).map(([label]) => label);
}

export function linkedPrFromTimeline(events: GhTimelineEvent[]): number | null {
  let linked: number | null = null;
  for (const event of events) {
    if (event.sourcePrNumber !== null) linked = event.sourcePrNumber;
  }
  return linked;
}
