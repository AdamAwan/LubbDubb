import type { Issue, IssueRelative } from '../types.js';
import type { MirroredTicket } from '../store/tickets.js';
import { isContainerType } from '../issueRelations.js';
import { isWatched } from '../watchLabels.js';
import type { FeatureNode, FeatureProgress, FeatureTree } from '../wire.js';

/**
 * The tracker's hierarchy as a tree, with what the fleet has made of each branch
 * rolled up it — the Features page's whole payload.
 *
 * ## Why this is a page rather than a heading
 *
 * The tickets tab already draws a feature as a heading over its children, and that
 * is the *list* question: which items am I being asked about, and what is the
 * harness doing with each. The question this answers is the other one — **is the
 * feature getting done** — and it is not a list question at all: it is a rollup
 * over a subtree, it spans levels the ticket list flattens to one, and it counts
 * items the assignment filter never returned. A list paginated at forty rows
 * cannot answer it, because a tree cut off part-way down reports a branch as
 * complete when the rest of it is on the next page.
 *
 * ## The three sources, and why none of them alone is the board
 *
 * - The **mirror** is the history: every item the assignment filter has ever
 *   returned, live or frozen, with the cost the fleet spent under it. It is the
 *   only source that remembers an item after it closed.
 * - The **world** is the live reading: the item's type, its native state, and —
 *   for a container the filter did return — its `children`, which is the only
 *   place the *full* membership of a feature is written down.
 * - The **relation summaries** carried on an issue (`parent`, `children`) name
 *   items neither of the other two holds: a Feature is usually visible only as
 *   something else's parent, and a story assigned to another team is visible only
 *   as its feature's child.
 *
 * The third is what makes the rollup honest. A feature whose eight stories include
 * three nobody here is assigned reads "5 of 5 done" from the mirror alone — which
 * is the one number a delivery conversation turns on, wrong, with nothing saying
 * so. Those three are counted, and counted as {@link FeatureProgress.outside}, so
 * the bar shows the shape of the feature and never claims a reading of work this
 * harness cannot see.
 *
 * ## What it decides: nothing
 *
 * A lens, in the sense `docs/spec/17-cockpit.md` uses: every reading it folds is
 * one somebody else already made — the watch tag through `src/watchLabels.ts`, the
 * container policy through `isContainerIssue`, the outcome word through
 * `ticketOutcomes`, the money through `buildSpendGoals`. Nothing under
 * `src/dispatcher/` reads it, and it forms no opinion of its own about an item.
 *
 * Pure, so the page's arithmetic is assertable without a world.
 *
 * → docs/spec/17-cockpit.md#the-features-page
 */
export interface FeatureTreeInput {
  /** The ticket mirror — the history, and the only source of cost and `tracking`. */
  items: readonly MirroredTicket[];
  /** The world baseline's issues — the live reading, and where `children` is written. */
  issues: readonly Issue[];
  /** Dollars under each goal, by issue number: `buildSpendGoals`' answer, never a second rollup. */
  costs: ReadonlyMap<number, number>;
  /** The harness's own outcome word for a goal it worked: `ticketOutcomes`' answer. */
  outcomes: ReadonlyMap<number, string>;
  /** Which hue each container draws in, by number — the store's persisted assignment. */
  featureSlots: ReadonlyMap<number, number>;
  /** The `-watch` tag, so the bucket is the dispatcher's own question. */
  watchLabel: string;
  /** `issueContainerTypes` — the operator's policy about what holds work rather than being it. */
  containerTypes: readonly string[];
}

/** What is known about one item, before it is placed in the tree. */
interface Entry {
  number: number;
  title: string;
  issueType: string | null;
  state: 'open' | 'closed';
  workItemState: string | null;
  /** Absent where nothing resolved a link; null where the tracker says there is none. */
  parent?: number | null;
  /** `undefined` where nothing told us — a relation-only item carries no labels. */
  watched?: boolean;
  costUsd: number | null;
  outcome: string | null;
  changedAt: string | null;
  tracking: 'live' | 'frozen' | null;
  /** Whether the assignment filter has ever returned this item. → {@link FeatureProgress.outside} */
  mirrored: boolean;
}

/** A zeroed rollup — the identity the fold starts from and what a childless node reports. */
function noProgress(): FeatureProgress {
  return { done: 0, working: 0, queued: 0, waiting: 0, outside: 0, total: 0, costUsd: 0 };
}

/**
 * Which of the five an item counts as, and the precedence is the whole of it.
 *
 * 1. **Closed is done**, whatever else is true of it. The tracker's own word about
 *    whether the work is finished outranks every reading the harness has, and an
 *    item closed while an agent was on it is finished work rather than work in
 *    flight.
 * 2. **Outside** is the item the assignment filter never returned — read second so
 *    a closed one still counts as done: it *is* done, and drawing it as unknown
 *    would understate a feature that has shipped.
 * 3. **Working** is money spent or a verdict cast. Both are records of the fleet
 *    having been on it, and either alone would miss half the cases — a run that
 *    cost nothing measurable, or a verdict reached by a desk rather than an agent.
 * 4. **Queued** is watched and untouched: opted in, waiting for a slot.
 * 5. **Waiting** is everything left — open, ours, and nobody has asked for it.
 */
function bucketOf(entry: Entry): keyof Omit<FeatureProgress, 'total' | 'costUsd'> {
  if (entry.state === 'closed') return 'done';
  if (!entry.mirrored) return 'outside';
  if ((entry.costUsd ?? 0) > 0 || entry.outcome !== null) return 'working';
  return entry.watched === true ? 'queued' : 'waiting';
}

/** Fold one item's bucket into a running rollup. Containers never enter their own. */
function add(into: FeatureProgress, entry: Entry): void {
  into[bucketOf(entry)] += 1;
  into.total += 1;
  into.costUsd += entry.costUsd ?? 0;
}

/** Fold a child's whole subtree in. */
function merge(into: FeatureProgress, from: FeatureProgress): void {
  into.done += from.done;
  into.working += from.working;
  into.queued += from.queued;
  into.waiting += from.waiting;
  into.outside += from.outside;
  into.total += from.total;
  into.costUsd += from.costUsd;
}

/** Cents, so a rollup does not read as float noise. */
function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * A relative as an entry — what a parent or child summary alone can say.
 *
 * `issueType` and `workItemState` arrive as empty strings on a relative rather
 * than absent, so they are folded back to null here: an empty chip drawn beside a
 * title reads as a state nobody named, where nothing drawn reads as what it is.
 */
function fromRelative(rel: IssueRelative): Entry {
  return {
    number: rel.number,
    title: rel.title,
    issueType: rel.issueType === '' ? null : rel.issueType,
    state: rel.state,
    workItemState: rel.workItemState === '' ? null : rel.workItemState,
    costUsd: null,
    outcome: null,
    changedAt: null,
    tracking: null,
    mirrored: false,
  };
}

/**
 * The tree, its rollups, and the two lists that sit either side of it.
 *
 * `tracked` is the page's own gate and is answered from the data rather than from
 * the provider's name: an item whose `parent` is *absent* is one no integration
 * resolved a link for, which is what a flat tracker produces for every row it ever
 * returns. GitHub Issues answer false here for as long as they carry no
 * hierarchy — and a provider that grows one lights the page up on the sweep after
 * it does, with nothing here to change.
 * → docs/spec/17-cockpit.md#the-features-page
 */
export function buildFeatureTree(input: FeatureTreeInput): FeatureTree {
  const { items, issues, costs, outcomes, featureSlots, watchLabel, containerTypes } = input;

  const entries = new Map<number, Entry>();
  /** Container membership as the *container* states it, which the child may not. */
  const declaredChildren = new Map<number, Set<number>>();
  let anyLink = false;

  const remember = (entry: Entry): Entry => {
    const held = entries.get(entry.number);
    if (held === undefined) {
      entries.set(entry.number, entry);
      return entry;
    }
    // Field by field rather than a spread, because the sources are *complementary*
    // rather than ranked: the mirror is the only one with cost and `tracking`, the
    // world the only one with the live type and state, and a relative the only one
    // that names an item neither holds. A whole-object overlay would drop whichever
    // arrived first.
    if (entry.title !== '') held.title = entry.title;
    if (entry.issueType !== null) held.issueType = entry.issueType;
    if (entry.workItemState !== null) held.workItemState = entry.workItemState;
    if (entry.parent !== undefined) held.parent = entry.parent;
    if (entry.watched !== undefined) held.watched = entry.watched;
    if (entry.costUsd !== null) held.costUsd = entry.costUsd;
    if (entry.outcome !== null) held.outcome = entry.outcome;
    if (entry.changedAt !== null) held.changedAt = entry.changedAt;
    if (entry.tracking !== null) held.tracking = entry.tracking;
    if (entry.mirrored) held.mirrored = true;
    // The live reading wins on the one field both always carry: the mirror stops
    // being enriched when an item freezes, and the world is by construction the
    // open set — so a disagreement here is the mirror being behind.
    held.state = entry.mirrored || held.state === 'closed' ? entry.state : held.state;
    return held;
  };

  for (const item of items) {
    if (item.parent !== undefined) anyLink = true;
    remember({
      number: item.number,
      title: item.title,
      issueType: item.issueType,
      state: item.state,
      workItemState: item.workItemState,
      ...(item.parent === undefined ? {} : { parent: item.parent === null ? null : item.parent.number }),
      watched: isWatched(item.labels, watchLabel),
      costUsd: costs.get(item.number) ?? null,
      outcome: outcomes.get(item.number) ?? null,
      changedAt: item.changedAt,
      tracking: item.tracking,
      mirrored: true,
    });
    // A parent named by a mirrored row and by nothing else — the common case, since
    // the filter that fills the mirror is about assignees and tags rather than
    // about features.
    if (item.parent) {
      remember({
        number: item.parent.number,
        title: item.parent.title,
        issueType: null,
        state: 'open',
        workItemState: null,
        costUsd: null,
        outcome: null,
        changedAt: null,
        tracking: null,
        mirrored: false,
      });
    }
  }

  for (const issue of issues) {
    if (issue.parent !== undefined) anyLink = true;
    remember({
      number: issue.number,
      title: issue.title,
      issueType: issue.issueType ?? null,
      state: issue.state,
      workItemState: issue.workItemState ?? null,
      ...(issue.parent === undefined ? {} : { parent: issue.parent === null ? null : issue.parent.number }),
      watched: isWatched(issue.labels, watchLabel),
      costUsd: costs.get(issue.number) ?? null,
      outcome: outcomes.get(issue.number) ?? null,
      changedAt: null,
      tracking: null,
      // The world is the live set, so an item in it has by definition been returned
      // by the filter — the mirror simply may not have swept it yet.
      mirrored: true,
    });
    if (issue.parent) remember({ ...fromRelative(issue.parent), state: issue.parent.state });
    for (const kid of issue.children ?? []) {
      anyLink = true;
      remember(fromRelative(kid));
      // Stated by the container, so a child the filter never returned still hangs
      // where the tracker says it does — the whole of what makes `outside` sayable.
      const held = entries.get(kid.number);
      if (held !== undefined && held.parent === undefined) held.parent = issue.number;
      const set = declaredChildren.get(issue.number) ?? new Set<number>();
      set.add(kid.number);
      declaredChildren.set(issue.number, set);
    }
    for (const sib of issue.siblings ?? []) remember(fromRelative(sib));
  }

  const isContainer = (entry: Entry): boolean => isContainerType(entry.issueType ?? undefined, containerTypes);

  // A parent by *position* is a container whatever the process template calls it:
  // something already hangs off it, so it is drawn as a heading rather than lost.
  const parents = new Set<number>();
  for (const entry of entries.values()) if (typeof entry.parent === 'number') parents.add(entry.parent);
  for (const number of declaredChildren.keys()) parents.add(number);

  const childrenOf = new Map<number, Set<number>>();
  for (const [number, set] of declaredChildren) childrenOf.set(number, new Set(set));
  for (const entry of entries.values()) {
    if (typeof entry.parent !== 'number') continue;
    const set = childrenOf.get(entry.parent) ?? new Set<number>();
    set.add(entry.number);
    childrenOf.set(entry.parent, set);
  }

  const holder = (number: number): boolean => {
    const entry = entries.get(number);
    return entry !== undefined && (parents.has(number) || isContainer(entry));
  };

  /**
   * One node and everything under it.
   *
   * `seen` is carried down the branch rather than kept globally: a tracker that
   * reports a cycle would otherwise recurse forever, and a *diamond* — an item
   * reachable down two branches, which a mis-set parent produces — is drawn under
   * both rather than dropped from whichever the walk reached second.
   */
  const build = (number: number, depth: number, seen: ReadonlySet<number>): FeatureNode | null => {
    const entry = entries.get(number);
    if (entry === undefined || seen.has(number)) return null;
    const next = new Set(seen).add(number);
    const kids = [...(childrenOf.get(number) ?? [])].sort((a, b) => a - b);
    const children = kids.flatMap((kid) => build(kid, depth + 1, next) ?? []);

    const progress = noProgress();
    for (const child of children) {
      // A container contributes its subtree and never itself: it is a statement of
      // intent that its children deliver, so counting it beside them would inflate
      // every feature by one item nobody can work. → `src/issueRelations.ts`
      if (child.container) merge(progress, child.progress);
      else {
        const childEntry = entries.get(child.number);
        if (childEntry !== undefined) add(progress, childEntry);
        merge(progress, child.progress);
      }
    }

    return {
      number: entry.number,
      title: entry.title,
      issueType: entry.issueType,
      state: entry.state,
      workItemState: entry.workItemState,
      container: holder(number),
      known: entry.mirrored ? 'mirror' : 'relation',
      watch: entry.watched === undefined ? null : entry.watched ? 'watched' : 'unwatched',
      outcome: entry.outcome,
      costUsd: entry.costUsd,
      changedAt: entry.changedAt,
      tracking: entry.tracking,
      slot: featureSlots.get(number) ?? null,
      depth,
      children,
      progress: { ...progress, costUsd: round(progress.costUsd) },
    };
  };

  const roots: FeatureNode[] = [];
  const orphans: FeatureNode[] = [];
  for (const entry of [...entries.values()].sort((a, b) => a.number - b.number)) {
    // A parent we know about places the item; one we have a number for but no entry
    // is a link the provider named and never returned, and its child is drawn at the
    // top rather than hidden under a heading that cannot be drawn.
    if (typeof entry.parent === 'number' && entries.has(entry.parent)) continue;
    const node = build(entry.number, 0, new Set());
    if (node === null) continue;
    if (node.container) roots.push(node);
    // Only a *resolved* absence is an orphan. An unreadable link is neither a
    // feature nor "no feature", and a bucket claiming to know which would be the
    // one mistake this whole module exists to refuse. → `src/issueRelations.ts`
    else if (entry.parent === null && entry.mirrored) orphans.push(node);
  }

  const totals = noProgress();
  for (const root of roots) merge(totals, root.progress);
  for (const orphan of orphans) {
    const entry = entries.get(orphan.number);
    if (entry !== undefined) add(totals, entry);
  }

  return { tracked: anyLink, roots, orphans, totals: { ...totals, costUsd: round(totals.costUsd) } };
}
