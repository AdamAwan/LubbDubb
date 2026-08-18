import type { ErrorRecorder } from '../../errorLog.js';
import type {
  IssueCommentInput,
  IssueLabelInput,
  SendResult,
  WorkItemLinkInput,
  WorkItemStateInput,
} from '../../sink/actionSink.js';
import type { Issue, IssueRelative, IssueState, TrackerItem } from '../../types.js';
import type {
  Capability,
  Integration,
  IssueCommentCapable,
  IssueLabelCapable,
  RefResolvable,
  TicketHistoryCapable,
  WorkItemLinkCapable,
  WorkItemStateCapable,
  WorldSlice,
} from '../integration.js';
import type { AzureDevOpsApi, AzWorkItem, AzWorkItemUpdate } from './azureDevOpsApi.js';
import { azureRefUrl } from './refUrl.js';

interface AzureWorkItemsOpts {
  /** The Azure DevOps client, already bound to a single organization/project. */
  api: AzureDevOpsApi;
  /** Central error sink: snapshot failures surface in the cockpit's Errors panel. */
  errors?: ErrorRecorder;
  /**
   * Azure target identity, for building web URLs. When unset, ref resolution
   * returns null — the same contract `GitHubIssuesIntegration` has for owner/repo.
   */
  organization?: string;
  project?: string;
  repository?: string;
  /** Only surface work items carrying this tag. Unset = all open work items. */
  workItemTag?: string;
  /** Only surface work items assigned to this uniqueName (UPN). Unset = all assignees. */
  assignedTo?: string;
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
export class AzureDevOpsWorkItemsIntegration
  implements
    Integration,
    RefResolvable,
    WorkItemStateCapable,
    WorkItemLinkCapable,
    IssueLabelCapable,
    IssueCommentCapable,
    TicketHistoryCapable
{
  readonly id = 'issues:azure';
  readonly capability: Capability = 'issues';

  private lastGood: Issue[] = [];

  constructor(private readonly opts: AzureWorkItemsOpts) {}

  resolveRefUrl(ref: string): string | null {
    const { organization, project, repository } = this.opts;
    return organization && project && repository ? azureRefUrl(organization, project, repository, ref) : null;
  }

  /**
   * The mirror's read: work items in either state changed since `since` (issue #329).
   *
   * Under the same `workItemTag` / `assignedTo` narrowing {@link snapshot} applies —
   * this provider's whole assignment filter — so the mirror holds the population the
   * harness works and not a wider one.
   *
   * Neither the hierarchy nor the tag-authorship revisions are hydrated, unlike the
   * snapshot: a history row is read and ordered, never dispatched from, and those
   * two reads are per-item. Paying them across a month of backfill would make the
   * first sweep cost a request per ticket.
   */
  async listTicketHistory(since: string): Promise<TrackerItem[]> {
    const { api, workItemTag, assignedTo } = this.opts;
    const raw = await api.listWorkItemsChangedSince(since, workItemTag, assignedTo);
    return raw.map((w) => ({
      number: w.id,
      title: w.title,
      labels: w.tags,
      state: normalizeState(w.state),
      // The raw System.State kept alongside the open/closed collapse, exactly as
      // the snapshot keeps it — and the only place a *closed* item's own word is
      // ever read, since the live overlay only ever sees the open set.
      workItemState: w.state,
      url: w.url,
      createdAt: w.createdAt,
      changedAt: w.changedAt,
    }));
  }

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, workItemTag, assignedTo, ownershipTag } = this.opts;
      const raw = await api.listOpenWorkItems(workItemTag, assignedTo);
      const viewer = ownershipTag ? await api.viewerUniqueName() : null;
      const hierarchy = await this.hydrateHierarchy(raw);
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
            issueType: w.workItemType,
            ...hierarchy(w),
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
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      return { issues: this.lastGood, stale: true };
    }
  }

  /**
   * Resolve the hierarchy around the snapshot's work items — the parent Feature,
   * the children, and the siblings under the same parent — into the relation
   * fields of {@link Issue}.
   *
   * Two batched reads at most, whatever the size of the board. The first fetches
   * every id the snapshot's own items point at (parents and children); the second
   * fetches the *other* children of those parents, which is where siblings come
   * from and which nothing in the first round names. Both are skipped entirely
   * when there is nothing to fetch, so a flat board costs no request at all.
   *
   * The listed items are narrowed by tag/assignee, so a parent Feature is almost
   * never among them — reading the relations off the item without hydrating them
   * would leave an id and no title, which is not context an agent can use.
   *
   * A failure here is recorded and then **dropped**: the returned mapper yields no
   * relation fields, which reads downstream as "this provider doesn't track
   * hierarchy" — the same shape GitHub has. Losing the hierarchy costs the note
   * appended to a prompt; faulting would cost the whole snapshot, and the world is
   * worth more than the annotation.
   */
  private async hydrateHierarchy(raw: AzWorkItem[]): Promise<(w: AzWorkItem) => Partial<Issue>> {
    const none = (): Partial<Issue> => ({});
    try {
      const listed = new Map(raw.map((w) => [w.id, w]));
      const known = new Map(listed);
      const wanted = new Set<number>();
      for (const w of raw) {
        if (w.parentId !== null) wanted.add(w.parentId);
        for (const id of w.childIds) wanted.add(id);
      }
      for (const w of await this.fetch([...wanted], known)) known.set(w.id, w);

      // Round two: a parent's *other* children. Only nameable once the parents
      // themselves have been read, which is why this cannot fold into round one.
      const siblings = new Set<number>();
      for (const w of raw) {
        const parent = w.parentId === null ? undefined : known.get(w.parentId);
        for (const id of parent?.childIds ?? []) if (id !== w.id) siblings.add(id);
      }
      for (const w of await this.fetch([...siblings], known)) known.set(w.id, w);

      return (w: AzWorkItem): Partial<Issue> => {
        const parent = w.parentId === null ? null : (known.get(w.parentId) ?? null);
        // An unreadable parent is *unknown*, not absent: reporting `null` here
        // would tell the orphan check this item belongs to no feature, which is a
        // different — and wrong — thing to say about a link we simply couldn't read.
        if (w.parentId !== null && parent === null) return { children: relatives(w.childIds, known) };
        return {
          parent: parent === null ? null : relative(parent, { withBody: true }),
          children: relatives(w.childIds, known),
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

  /** Read the ids not already in hand. Nothing to fetch costs no request. */
  private async fetch(ids: number[], known: Map<number, AzWorkItem>): Promise<AzWorkItem[]> {
    const missing = ids.filter((id) => !known.has(id));
    return missing.length === 0 ? [] : this.opts.api.getWorkItems(missing);
  }

  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    await this.opts.api.setWorkItemState(input.number, input.state);
    return { ok: true };
  }

  /**
   * The work item's side of "every pull request has a work item".
   *
   * On the `issues` provider rather than the source-control one because the write
   * is a work-item PATCH — Azure derives a pull request's `workItemRefs` from these
   * relations and offers no way to set them from the pull request. The next snapshot
   * reads the relation straight back out as `linkedPrNumber`, which is what closes
   * the loop: the desk's own idempotence check is the provider's answer, not a
   * belief the harness holds separately.
   */
  async linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    await this.opts.api.linkWorkItemToPull(input.number, input.prNumber);
    return { ok: true, ref: `#${input.number} -> PR ${input.prNumber}` };
  }

  /**
   * The plan's status comment on the work item's discussion: created once, then
   * edited in place by the id the create returned — one living comment per plan
   * rather than a stream. Azure addresses an edit by (work item, comment), so both
   * ride in.
   */
  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const existing = input.commentRef === null ? null : Number(input.commentRef);
    const ref =
      existing !== null && Number.isInteger(existing)
        ? await this.opts.api.updateWorkItemComment(input.number, existing, input.body)
        : await this.opts.api.createWorkItemComment(input.number, input.body);
    return { ok: true, ref: String(ref.id) };
  }

  /** The outbound side of the watch/ignore toggle: add/remove a `System.Tags` entry. */
  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    await this.opts.api.setWorkItemTag(input.number, input.label, input.present);
    return { ok: true };
  }
}

/**
 * One work item as the summary carried on another — a parent, child or sibling.
 *
 * The body rides only on a parent (`withBody`), because a Feature's description is
 * the goal its children serve and is the one piece of related text an agent needs;
 * carrying every sibling's description would put a whole feature's worth of text
 * on every issue in the snapshot for no reader.
 */
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

/**
 * The relatives for a list of ids, in id order. Ids that were not read — deleted,
 * or in a project this identity cannot see — are **dropped** rather than rendered
 * as a bare number: a relation the harness cannot describe is not context.
 */
function relatives(ids: number[], known: Map<number, AzWorkItem>): IssueRelative[] {
  const out: IssueRelative[] = [];
  for (const id of ids) {
    const w = known.get(id);
    if (w) out.push(relative(w));
  }
  return out;
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
