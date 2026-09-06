import type { Issue, IssueRelative } from './types.js';

/**
 * What a tracker's hierarchy means to the harness. Two rules: a container (Feature/Epic) is
 * never worked directly, and a leaf is meant to have a parent — a missing one is reported, never
 * guessed. Everything here is pure over the issue plus operator policy, so the gate, the agent's
 * note and the cockpit chip cannot form different opinions.
 */

/** Work-item types that hold other work rather than being work — the default for `issueContainerTypes`, overridable per process template. Matched case-insensitively. */
export const DEFAULT_CONTAINER_TYPES: readonly string[] = ['Feature', 'Epic'];

/**
 * Types whose items are expected to hang off a container — the default for `issueParentedTypes`;
 * anything else is left out of the orphan report. A default, never a closed list: a project
 * naming its types differently would otherwise have the missing-parent question silently never
 * asked, on every item, with nothing red. Matched case-insensitively.
 */
export const DEFAULT_PARENTED_TYPES: readonly string[] = [
  'User Story',
  'Story',
  'Product Backlog Item',
  'Requirement',
  'Bug',
  'Tech Debt',
  'Technical Debt',
  'Debt',
  'Issue',
];

/** Case-insensitive membership, the way every type comparison here is made. */
function includesType(types: readonly string[], type: string): boolean {
  const needle = type.trim().toLowerCase();
  return types.some((t) => t.trim().toLowerCase() === needle);
}

/** Is this a container type — a Feature or an Epic — under the operator's policy? An issue with no `issueType` (GitHub, the fake) is never a container, keeping every flat tracker unchanged. */
export function isContainerIssue(issue: Issue, containerTypes: readonly string[] | undefined): boolean {
  return isContainerType(issue.issueType ?? null, containerTypes);
}

/** The same question asked of a bare type word — for the feature board (`src/features/`), which reads `tracker_items` and never the world. Shared so the two cannot disagree. A null type is never a container. */
export function isContainerType(type: string | null, containerTypes: readonly string[] | undefined): boolean {
  if (type === null) return false;
  return includesType(containerTypes ?? DEFAULT_CONTAINER_TYPES, type);
}

/** The pickup gate's reason for leaving a container alone, or null when the item is workable. Phrased as "what to work instead" — "Feature" on its own reads as a classification, not a refusal. */
export function containerPickupReason(issue: Issue, containerTypes: readonly string[] | undefined): string | null {
  if (!isContainerIssue(issue, containerTypes)) return null;
  const kids = issue.children?.length ?? 0;
  const open = (issue.children ?? []).filter((c) => c.state === 'open').length;
  const what =
    kids === 0
      ? 'it has no children to work'
      : `work its ${kids} child item${kids === 1 ? '' : 's'}${open > 0 ? ` (${open} still open)` : ''}`;
  return `${issue.issueType} is a container — ${what}`;
}

/**
 * Is this a leaf that should have had a parent and doesn't? Three conditions: the provider
 * tracks hierarchy (`parent === null`, not `undefined` — otherwise every GitHub issue is an
 * orphan), the item is not itself a container, and its type is one teams put under a feature.
 * Gates the note and the missing-parent question, so a project it answers "no" for never hears
 * about a missing parent at all.
 */
export function isOrphanIssue(
  issue: Issue,
  containerTypes: readonly string[] | undefined,
  parentedTypes?: readonly string[] | undefined,
): boolean {
  if (issue.parent !== null) return false; // undefined = untracked, object = has one
  if (isContainerIssue(issue, containerTypes)) return false;
  return issue.issueType !== undefined && includesType(parentedTypes ?? DEFAULT_PARENTED_TYPES, issue.issueType);
}

/**
 * Every item a watch write on `issue` reaches: the item itself, then — when it is a container —
 * every descendant beneath it, breadth-first and in issue order. Watching a Feature means
 * watching the work it stands for; un-watching walks the same tree, so a dropped feature can't
 * leave its children tagged and still being worked. Follows the world, so an id the provider
 * never returned is reported as a leaf rather than dropped.
 */
export function watchCascadeTargets(
  issue: Issue,
  issues: readonly Issue[],
  containerTypes: readonly string[] | undefined,
): number[] {
  const targets = [issue.number];
  if (!isContainerIssue(issue, containerTypes)) return targets;

  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const seen = new Set([issue.number]);
  // Breadth-first, so a partial failure stops at a tree level rather than
  // part-way down one branch.
  const queue: Issue[] = [issue];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const kids = [...(next.children ?? [])].sort((a, b) => a.number - b.number);
    for (const kid of kids) {
      if (seen.has(kid.number)) continue;
      seen.add(kid.number);
      targets.push(kid.number);
      const held = byNumber.get(kid.number);
      if (held !== undefined) queue.push(held);
    }
  }
  return targets;
}

/** How much of a parent's description rides into a prompt before it is cut. */
const PARENT_BODY_LIMIT = 4000;

/** How many candidate parents an orphan's note offers. Applied where the note is written, never inside {@link candidateParents} — the cockpit's picker must stay whole. */
const CANDIDATE_LIMIT = 12;

/**
 * The containers an orphan could plausibly belong to — every open Feature/Epic the harness can
 * see, taken both from the world's own containers and from the parents of other items (where
 * most come from, since the provider's list is narrowed by tag/assignee). Deduplicated by
 * number, open only, in id order. Whole; capped only where written into a prompt ({@link CANDIDATE_LIMIT}).
 */
export function candidateParents(issues: readonly Issue[], containerTypes?: readonly string[]): IssueRelative[] {
  const byNumber = new Map<number, IssueRelative>();
  for (const issue of issues) {
    if (isContainerIssue(issue, containerTypes) && issue.state === 'open') {
      byNumber.set(issue.number, {
        number: issue.number,
        title: issue.title,
        issueType: issue.issueType ?? '',
        workItemState: issue.workItemState ?? '',
        state: issue.state,
      });
    }
    const parent = issue.parent;
    // A parent is a container by position rather than by type.
    if (parent && parent.state === 'open' && !byNumber.has(parent.number)) {
      byNumber.set(parent.number, { ...parent, body: undefined });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** One relative as a single line: `Bug #14 "Totals drift" (Active)`. */
function relativeLine(rel: IssueRelative): string {
  return `${rel.issueType} #${rel.number} "${rel.title}" (${rel.workItemState})`;
}

/**
 * What an agent must know about the item's neighbourhood, appended to a rendered prompt —
 * never interpolated, since an operator's override that never learned a new placeholder would
 * drop it silently. Empty when there is nothing to say. → `docs/spec/05-dispatcher.md`
 */
export function relatedWorkNote(
  issue: Issue,
  containerTypes?: readonly string[],
  candidates: readonly IssueRelative[] = [],
  parentedTypes?: readonly string[],
): string {
  const lines: string[] = [];

  if (issue.parent) {
    const p = issue.parent;
    lines.push(`This item belongs to ${relativeLine(p)}.`);
    const body = (p.body ?? '').trim();
    if (body !== '') {
      const shown = body.length > PARENT_BODY_LIMIT ? `${body.slice(0, PARENT_BODY_LIMIT)}\n…(truncated)` : body;
      // The parent's description is the overall goal the item serves.
      lines.push(`That parent's description — the overall goal this item serves:\n\n${shown}`);
    } else {
      lines.push(
        `That parent carries no description, so the overall goal it serves is not written down anywhere the ` +
          `harness can read. Work from this item alone and say so rather than assuming the wider goal.`,
      );
    }
  } else if (isOrphanIssue(issue, containerTypes, parentedTypes)) {
    lines.push(
      `This item has no parent feature. Stories, bugs and tech-debt items are expected to belong to one, so the ` +
        `wider goal it serves is not recorded. Do not invent a parent or widen the work to a goal you inferred — ` +
        `work what this item says, and note the missing parent in your write-up.`,
    );
    // The suggestion, not the link: the harness reads the tracker's hierarchy and
    // never writes it. Offered only for an orphan, and capped here rather than in
    // `candidateParents` so the cockpit's picker stays whole.
    const open = candidates.filter((c) => c.number !== issue.number).slice(0, CANDIDATE_LIMIT);
    if (open.length > 0) {
      lines.push(
        `Open features it might belong to:\n${open.map((c) => `- ${relativeLine(c)}`).join('\n')}\n\n` +
          `Say which one it most likely belongs to, or that none of them fit — whichever you can support from ` +
          `this item's own text. That is a suggestion for a human to act on: do not link, re-parent or edit any ` +
          `work item yourself.`,
      );
    }
  }

  const siblings = issue.siblings ?? [];
  if (siblings.length > 0) {
    lines.push(
      `Alongside it under that parent:\n${siblings.map((s) => `- ${relativeLine(s)}`).join('\n')}\n\n` +
        `Those are other people's scope, not yours. They tell you where this item's edges are — do not do their ` +
        `work, and do not duplicate what a closed one already delivered.`,
    );
  }

  const children = issue.children ?? [];
  if (children.length > 0) {
    lines.push(
      `It has children of its own, which are where its work actually lives:\n` +
        `${children.map((c) => `- ${relativeLine(c)}`).join('\n')}`,
    );
  }

  return lines.length === 0 ? '' : `\n\nRelated tracker items:\n\n${lines.join('\n\n')}`;
}
