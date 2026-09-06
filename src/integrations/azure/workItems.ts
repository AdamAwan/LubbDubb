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
   * When set, resolve tag authorship for items carrying this tag and expose the viewer-added
   * subset as `labelsAddedByViewer`, so the ownership gate can ignore a tag a third party
   * added. Unset means no authorship tracking and no per-item revision fetch.
   */
  ownershipTag?: string;
}

/**
 * The real `issues` provider for Azure DevOps, reading the Work Item Tracking API. A drop-in
 * for {@link GitHubIssuesIntegration} that reads the network rather than an injected world,
 * so it is *not* `Injectable`. Work-item tags map onto issue `labels`, which is what keeps
 * the provider-agnostic pickup and priority gates working unchanged.
 */
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
  /**
   * Work item descriptions and comments are HTML fields, so Markdown sent to one arrives as
   * its own punctuation. The pull-request side of the same provider renders Markdown, which
   * is why this rides on the integration rather than the provider family.
   */
  readonly bodyFormat = 'html' as const;

  private lastGood: Issue[] | null = null;
  /**
   * Tag authorship per work item, gated on the revision the answer was derived from — the one
   * per-item read this provider makes ({@link viewerAddedTagsFor}). Unlike {@link lastGood},
   * which replays a world of unknown age as `stale`, this is a current answer that cost no
   * request and never touches that flag.
   */
  private readonly tagAuthorship = new HydrationCache<{ token: string; tags: string[] }>();

  constructor(private readonly opts: AzureWorkItemsOpts) {}

  resolveRefUrl(ref: string): string | null {
    const { organization, project, repository } = this.opts;
    return organization && project && repository ? azureRefUrl(organization, project, repository, ref) : null;
  }

  /**
   * The mirror's read: work items in either state changed since `since`, under the same
   * `workItemTag` / `assignedTo` narrowing {@link snapshot} applies, so the mirror holds the
   * population the harness works. Neither the hierarchy nor the tag-authorship revisions are
   * hydrated — both are per-item, and a month of backfill would cost a request per ticket.
   */
  async listTicketHistory(since: string): Promise<TrackerItem[]> {
    const { api, workItemTag, assignedTo } = this.opts;
    const raw = await api.listWorkItemsChangedSince(since, workItemTag, assignedTo);
    return raw.map((w) => ({
      number: w.id,
      title: w.title,
      labels: w.tags,
      state: normalizeState(w.state),
      // The raw System.State beside the open/closed collapse, as the snapshot keeps it — and
      // the only place a closed item's own word is read, since the overlay sees only the open set.
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
          // Only pay the per-item revision fetch when the gate is on and the item carries
          // the gate tag — others cannot be picked up anyway.
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
            // The raw System.State, which the state-based pickup gate and "in review"
            // back-off both read.
            workItemState: w.state,
            linkedPrNumber: linkedPrFromRelations(w.relationUrls),
            url: w.url,
          };
        }),
      );
      // Anything out of the open set is never asked about again. After the fan-out, so a hit
      // this pulse is not evicted before it is read.
      this.tagAuthorship.retain(raw.map((w) => w.id));
      this.lastGood = issues;
      return { issues };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      // Nothing to degrade to: an empty slice would make every watched work item look gone,
      // so fail the pulse instead.
      if (this.lastGood === null) throw err;
      return { issues: this.lastGood, stale: true };
    }
  }

  /**
   * The tags **this viewer** added to `w`, from its revision history — the
   * `labelsAddedByViewer` the dispatcher's ownership gate reads.
   *
   * Change-gated on `(viewer, System.ChangedDate)`, which covers the answer exactly: every
   * revision Azure accepts stamps `ChangedDate`, and only a revision can change tag
   * authorship. A wrong empty answer here resolves every issue's labels to `[]`, at which
   * point nothing is ever picked up and nothing is red — so an item reported without a
   * `changedAt` is never gated and never stored, and is read afresh every pulse.
   * → [06](../../../docs/spec/06-issue-pickup.md)
   */
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

  /**
   * Resolve the relations around the snapshot's work items — parent, children, siblings and
   * Predecessors — into the relation fields of {@link Issue}.
   *
   * Two batched reads at most: the ids the snapshot's items point at, then the *other*
   * children of those parents (the siblings), which nothing in the first round names. Both
   * are skipped when there is nothing to fetch, so a flat board costs no request.
   *
   * A failure is recorded and then **dropped** — the mapper yields no relation fields, which
   * reads downstream as a provider that does not track hierarchy. Losing the hierarchy costs
   * a note on a prompt; faulting would cost the whole snapshot.
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
        // Predecessors ride in this batch: a dependency is almost always a sibling under
        // the same Feature, so the ids are usually listed already.
        for (const id of w.dependsOnIds) wanted.add(id);
      }
      for (const w of await this.fetch([...wanted], known)) known.set(w.id, w);

      // Round two: a parent's *other* children, only nameable once the parents are read.
      const siblings = new Set<number>();
      for (const w of raw) {
        const parent = w.parentId === null ? undefined : known.get(w.parentId);
        for (const id of parent?.childIds ?? []) if (id !== w.id) siblings.add(id);
      }
      for (const w of await this.fetch([...siblings], known)) known.set(w.id, w);

      return (w: AzWorkItem): Partial<Issue> => {
        const parent = w.parentId === null ? null : (known.get(w.parentId) ?? null);
        // An unreadable parent is *unknown*, not absent: `null` would tell the orphan check
        // this item belongs to no feature.
        if (w.parentId !== null && parent === null) {
          return { children: relatives(w.childIds, known), dependsOn: relatives(w.dependsOnIds, known) };
        }
        return {
          parent: parent === null ? null : relative(parent, { withBody: true }),
          children: relatives(w.childIds, known),
          // Always present, empty included: an empty list says this board tracks
          // dependencies and this item waits on none, which the sequence gate reads
          // differently from a flat tracker's `undefined`.
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
   * The work item's side of "every pull request has a work item". On the `issues` provider
   * because the write is a work-item PATCH — Azure offers no way to set it from the pull
   * request. The next snapshot reads it back as `linkedPrNumber`, so the desk's idempotence
   * check is the provider's answer rather than a belief the harness holds.
   */
  async linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    await this.opts.api.linkWorkItemToPull(input.number, input.prNumber);
    return { ok: true, ref: `#${input.number} -> PR ${input.prNumber}` };
  }

  /**
   * The plan's status comment on the work item's discussion: created once, then edited in
   * place by the id the create returned — one living comment per plan, not a stream.
   */
  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const existing = input.commentRef === null ? null : Number(input.commentRef);
    const ref =
      existing !== null && Number.isInteger(existing)
        ? await this.opts.api.updateWorkItemComment(input.number, existing, input.body)
        : await this.opts.api.createWorkItemComment(input.number, input.body);
    return { ok: true, ref: String(ref.id) };
  }

  /**
   * File a new work item. Both halves of a correct filing happen here: the item is created
   * **as** its type and carrying its tags — an untagged item is one the pickup gate can miss
   * — and then the `related` link is hung off it where the caller named one. Two writes,
   * because Azure cannot create an already-related item; one call, so no caller can forget
   * the second. A failed relation does not cost the item: the throw carries its id.
   */
  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    const created = await this.opts.api.createWorkItem({
      // Null never reaches here from a filing caller; `Task` is the historical default,
      // what the prompt hardcoded before the harness chose types.
      type: input.type ?? 'Task',
      title: input.title,
      description: input.body,
      tags: input.labels,
      assignedTo: input.assignee,
    });
    const ref = `issue:${created.id}`;
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

  /**
   * The project's area tree, straight from the provider. Not cached here:
   * `AreaPathDirectory` (`src/intake/areaPaths.ts`) owns how often it is asked, and a second
   * cache would be a second policy free to disagree with it.
   */
  async listAreaPaths(): Promise<AreaPathTree> {
    return this.opts.api.listAreaPaths();
  }

  /**
   * Hang this item off its container, via `System.LinkTypes.Hierarchy-Reverse` — what a
   * rollup and a board position are made of, unlike the `related` edge `createIssue` hangs.
   */
  async setWorkItemParent(input: WorkItemParentInput): Promise<SendResult> {
    await this.opts.api.setWorkItemParent(input.number, input.parentNumber);
    return { ok: true, ref: `#${input.number} -> #${input.parentNumber}` };
  }

  /** Move this item onto a classification node — the write that puts it on a team's board. */
  async setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult> {
    await this.opts.api.setWorkItemAreaPath(input.number, input.areaPath);
    return { ok: true, ref: input.areaPath };
  }

  /** The outbound side of the watch/ignore toggle: add/remove a `System.Tags` entry. */
  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    await this.opts.api.setWorkItemTag(input.number, input.label, input.present);
    return { ok: true };
  }
}

/**
 * One work item as the summary carried on another — a parent, child or sibling. The body
 * rides only on a parent (`withBody`): a Feature's description is the goal its children
 * serve, where every sibling's would be a feature's worth of text with no reader.
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
 * Which tags the viewer added, folded from a work item's revision updates: a tag in `tagsNew`
 * but not `tagsOld` was added by that revision's author. Later revisions win — a re-add by
 * someone else transfers ownership away, a removal clears it, a revision that did not touch
 * tags leaves it alone. Pure, so it is testable without the network.
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
 * The PR that resolves a work item, from its ArtifactLink relations
 * (`vstfs:///Git/PullRequestId/{project}%2F{repoId}%2F{prId}` — the trailing segment is the
 * PR id). The most recently listed link, or `null` when nothing links a PR. Pure.
 */
export function linkedPrFromRelations(relationUrls: string[]): number | null {
  let linked: number | null = null;
  for (const url of relationUrls) {
    const match = /\/Git\/PullRequestId\/.*(?:%2F|\/)(\d+)$/i.exec(url);
    if (match) linked = Number(match[1]);
  }
  return linked;
}
