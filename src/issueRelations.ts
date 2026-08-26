import type { Issue, IssueRelative } from './types.js';

/**
 * What a tracker's *hierarchy* means to the harness.
 *
 * GitHub Issues are flat: one kind of item, no parent, and every gate in the
 * dispatcher was written against that. Azure DevOps Boards are not — a work item
 * has a type and hangs in a tree, and two rules of that tree change what the
 * harness may do with an item rather than merely describing it:
 *
 * - **A container is never worked directly.** A Feature is a statement of intent
 *   that its stories deliver; dispatching an agent at one asks it to implement a
 *   goal whose decomposition already exists in the tracker, next to it.
 * - **A leaf is meant to have a parent.** A story, bug or tech-debt item under no
 *   feature is an item whose *why* is nowhere — which the harness reports and does
 *   not invent, because guessing the feature is the one mistake that would be
 *   invisible in the resulting work.
 *
 * Everything here is pure over the issue plus operator policy, so both the gate
 * and the note the agent reads are unit-testable without a world, and the cockpit
 * chip and the dispatcher cannot form different opinions about the same item.
 */

/**
 * Work-item types that hold other work rather than being work — the default for
 * `issueContainerTypes`. Azure's own process templates name these consistently
 * across Agile ("Feature"/"Epic"), Scrum and CMMI, so the default is right for a
 * stock project and an operator with a customised process overrides it.
 *
 * Matched case-insensitively, because a process template's type names are display
 * strings and an operator writing "feature" in config means the same thing.
 */
export const DEFAULT_CONTAINER_TYPES: readonly string[] = ['Feature', 'Epic'];

/**
 * Types whose items are expected to hang off a container. Everything a team
 * actually works is here; anything else (a Task under a story, say) is left out
 * of the orphan report rather than being nagged about a parent it doesn't need.
 */
const PARENTED_TYPES: ReadonlySet<string> = new Set([
  'user story',
  'story',
  'product backlog item',
  'requirement',
  'bug',
  'tech debt',
  'technical debt',
  'debt',
  'issue',
]);

/** Case-insensitive membership, the way every type comparison here is made. */
function includesType(types: readonly string[], type: string): boolean {
  const needle = type.trim().toLowerCase();
  return types.some((t) => t.trim().toLowerCase() === needle);
}

/**
 * Is this a container type — a Feature or an Epic — under the operator's policy?
 *
 * An issue with no `issueType` (GitHub, the fake) is never a container, which is
 * what keeps every flat tracker behaving exactly as it did.
 */
export function isContainerIssue(issue: Issue, containerTypes: readonly string[] | undefined): boolean {
  return isContainerType(issue.issueType ?? null, containerTypes);
}

/**
 * The same question asked of a bare type word — what the mirror holds, where
 * {@link isContainerIssue} needs a whole world issue.
 *
 * Split out rather than duplicated for the feature board (`src/features/`), which
 * reads `tracker_items` and never the world: a second case-folding of the
 * operator's `issueContainerTypes` is a second opinion about which items are work,
 * and the two would disagree on exactly the deployment that spells its process
 * template differently.
 *
 * A null type (GitHub, the fake) is never a container, which is what keeps every
 * flat tracker behaving exactly as it did.
 */
export function isContainerType(type: string | null, containerTypes: readonly string[] | undefined): boolean {
  if (type === null) return false;
  return includesType(containerTypes ?? DEFAULT_CONTAINER_TYPES, type);
}

/**
 * The pickup gate's reason for leaving a container alone, or null when the item
 * is workable. Phrased as the other half of the sentence — what to work instead —
 * because "Feature" on its own reads as a classification, not a refusal.
 */
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
 * Is this a leaf that should have had a parent and doesn't?
 *
 * Three conditions, and all three matter. The provider must *track* hierarchy
 * (`parent === null`, not `undefined`) — otherwise every GitHub issue is an
 * orphan. It must not be a container itself, since a Feature legitimately sits at
 * the top. And its type must be one teams put under a feature, so a Task under a
 * story is not reported as parentless when it never wanted a feature.
 */
export function isOrphanIssue(issue: Issue, containerTypes: readonly string[] | undefined): boolean {
  if (issue.parent !== null) return false; // undefined = untracked, object = has one
  if (isContainerIssue(issue, containerTypes)) return false;
  return issue.issueType !== undefined && PARENTED_TYPES.has(issue.issueType.trim().toLowerCase());
}

/**
 * Every item a watch write on `issue` reaches: the item itself, then — when it is
 * a container — every descendant beneath it, breadth-first and in issue order.
 *
 * **Watching a Feature means watching the work it stands for.** A container is
 * never worked itself, so a tag on one alone would change nothing an operator can
 * see; the promise the click makes is about the stories under it, and this is the
 * list that keeps it. Un-watching walks the same tree, which is what stops a
 * dropped feature leaving its children tagged and still being worked.
 *
 * The walk is over the **world**, not the relation summaries: a child is followed
 * further only when the snapshot holds it as an issue of its own, so an Epic
 * reaches its features' stories while an id the provider never returned is
 * reported as a leaf rather than silently dropped. `children` on a relative names
 * nothing further, so the recursion is finite even before the seen-set.
 *
 * Pure over the issue plus the world, so the route's write list and anything the
 * cockpit says the click will do are the same list.
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
  // Breadth-first, so a feature's own stories are written before its
  // sub-features' — a partial failure then stops at a tree level rather than
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

/**
 * How many candidate parents an orphan's note offers. A list long enough to be a
 * menu stops being a suggestion — and the agent's job is to name the best fit or
 * say none of them are it, not to work through a board.
 */
const CANDIDATE_LIMIT = 12;

/**
 * The containers an orphan could plausibly belong to — every open Feature/Epic
 * the harness can see, from two places, because neither alone is the board:
 *
 * - the **containers in the world** itself, and
 * - the **parents of other items**, which is where most of them come from: the
 *   provider's item list is narrowed by tag/assignee, so a Feature is usually
 *   visible only as something else's parent.
 *
 * Deduplicated by number, open only — a closed feature is not somewhere to put
 * new work — and in id order so the same board produces the same list twice
 * running. Pure over the world, so the suggestion an agent is offered and the one
 * the cockpit could show are the same list.
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
    // A parent is a container by position rather than by type — whatever the
    // process template calls it, something already hangs off it.
    if (parent && parent.state === 'open' && !byNumber.has(parent.number)) {
      byNumber.set(parent.number, { ...parent, body: undefined });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number).slice(0, CANDIDATE_LIMIT);
}

/** One relative as a single line: `Bug #14 "Totals drift" (Active)`. */
function relativeLine(rel: IssueRelative): string {
  return `${rel.issueType} #${rel.number} "${rel.title}" (${rel.workItemState})`;
}

/**
 * What an agent must know about the item's neighbourhood, as a block **appended**
 * to a rendered prompt — never interpolated into one.
 *
 * Appending is the rule every added instruction follows (see `planApprovalWarnings`
 * and `docs/spec/05-dispatcher.md`): prompt templates are operator-overridable and
 * `loadPromptTemplates` rejects only *unknown* placeholders, so a `{related}` token
 * would be dropped silently by exactly the deployments that customised most —
 * losing the feature's goal on the installs most likely to have one.
 *
 * Empty when there is nothing to say — a flat tracker, or a leaf whose parent is
 * simply present and unremarkable produces the parent block and nothing else — so
 * nothing is appended at all and the GitHub path is byte-for-byte what it was.
 */
export function relatedWorkNote(
  issue: Issue,
  containerTypes?: readonly string[],
  candidates: readonly IssueRelative[] = [],
): string {
  const lines: string[] = [];

  if (issue.parent) {
    const p = issue.parent;
    lines.push(`This item belongs to ${relativeLine(p)}.`);
    const body = (p.body ?? '').trim();
    if (body !== '') {
      const shown = body.length > PARENT_BODY_LIMIT ? `${body.slice(0, PARENT_BODY_LIMIT)}\n…(truncated)` : body;
      // The parent's description is the overall goal; the item you were handed is
      // one step towards it, and saying so is the whole point of carrying it.
      lines.push(`That parent's description — the overall goal this item serves:\n\n${shown}`);
    } else {
      lines.push(
        `That parent carries no description, so the overall goal it serves is not written down anywhere the ` +
          `harness can read. Work from this item alone and say so rather than assuming the wider goal.`,
      );
    }
  } else if (isOrphanIssue(issue, containerTypes)) {
    lines.push(
      `This item has no parent feature. Stories, bugs and tech-debt items are expected to belong to one, so the ` +
        `wider goal it serves is not recorded. Do not invent a parent or widen the work to a goal you inferred — ` +
        `work what this item says, and note the missing parent in your write-up.`,
    );
    // The suggestion, not the link: the harness reads the tracker's hierarchy and
    // never writes it, so what an agent can do about an orphan is name the feature
    // a human should hang it off. Offered only for an orphan — a suggestion beside
    // an item that already has a parent is an invitation to re-file work.
    const open = candidates.filter((c) => c.number !== issue.number);
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
