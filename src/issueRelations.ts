import type { Issue, IssueRelative } from './types.js';

// → docs/spec/06-issue-pickup.md

export const DEFAULT_CONTAINER_TYPES: readonly string[] = ['Feature', 'Epic'];

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

function includesType(types: readonly string[], type: string): boolean {
  const needle = type.trim().toLowerCase();
  return types.some((t) => t.trim().toLowerCase() === needle);
}

export function isContainerIssue(issue: Issue, containerTypes: readonly string[] | undefined): boolean {
  return isContainerType(issue.issueType ?? null, containerTypes);
}

export function isContainerType(type: string | null, containerTypes: readonly string[] | undefined): boolean {
  if (type === null) return false;
  return includesType(containerTypes ?? DEFAULT_CONTAINER_TYPES, type);
}

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

export function isOrphanIssue(
  issue: Issue,
  containerTypes: readonly string[] | undefined,
  parentedTypes?: readonly string[] | undefined,
): boolean {
  if (issue.parent !== null) return false;
  if (isContainerIssue(issue, containerTypes)) return false;
  return issue.issueType !== undefined && includesType(parentedTypes ?? DEFAULT_PARENTED_TYPES, issue.issueType);
}

export function watchCascadeTargets(
  issue: Issue,
  issues: readonly Issue[],
  containerTypes: readonly string[] | undefined,
): number[] {
  const targets = [issue.number];
  if (!isContainerIssue(issue, containerTypes)) return targets;

  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const seen = new Set([issue.number]);
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

const PARENT_BODY_LIMIT = 4000;

const CANDIDATE_LIMIT = 12;

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
    if (parent && parent.state === 'open' && !byNumber.has(parent.number)) {
      byNumber.set(parent.number, { ...parent, body: undefined });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

function relativeLine(rel: IssueRelative): string {
  return `${rel.issueType} #${rel.number} "${rel.title}" (${rel.workItemState})`;
}

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
