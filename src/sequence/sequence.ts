import { createHash } from 'node:crypto';
import type { Issue, IssueRelative } from '../types.js';
import { isContainerIssue } from '../issueRelations.js';
import { linkEdges, type SequenceEdge } from './readiness.js';

// → docs/spec/33-story-sequencing.md

interface FeatureGroup {
  feature: IssueRelative;
  children: Issue[];
  members: number[];
}

function featureGroups(
  issues: readonly Issue[],
  containerTypes: readonly string[] | undefined,
  watched: (issue: Issue) => boolean,
): FeatureGroup[] {
  const groups = new Map<number, FeatureGroup>();
  for (const issue of issues) {
    const parent = issue.parent;
    if (!parent) continue;
    if (isContainerIssue(issue, containerTypes)) continue;
    if (!watched(issue)) continue;
    const group = groups.get(parent.number) ?? { feature: parent, children: [], members: [] };
    group.members.push(issue.number);
    if (issue.state === 'open') group.children.push(issue);
    groups.set(parent.number, group);
  }
  for (const group of groups.values()) {
    group.children.sort((a, b) => a.number - b.number);
    group.members.sort((a, b) => a - b);
  }
  return [...groups.values()].sort((a, b) => a.feature.number - b.feature.number);
}

export function featureSequenceKey(members: readonly number[], edges: readonly SequenceEdge[]): string {
  const lines = [...members.map((n) => `c ${n}`), ...edges.map((e) => `e ${e.issue} ${e.dependsOn}`)].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}

export function findCycle(edges: readonly SequenceEdge[]): number[] | null {
  const out = new Map<number, number[]>();
  for (const edge of edges) {
    const from = out.get(edge.issue);
    if (from) from.push(edge.dependsOn);
    else out.set(edge.issue, [edge.dependsOn]);
  }
  const done = new Set<number>();
  const path: number[] = [];
  const onPath = new Set<number>();

  const walk = (node: number): number[] | null => {
    if (done.has(node)) return null;
    const seen = path.indexOf(node);
    if (onPath.has(node)) return [...path.slice(seen), node];
    onPath.add(node);
    path.push(node);
    for (const next of out.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(node);
    done.add(node);
    return null;
  };

  for (const node of out.keys()) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return null;
}

export const DEFAULT_SEQUENCE_MAX_CHILDREN = 40;

export interface SequenceableFeature extends FeatureGroup {
  key: string;
}

export function sequenceableFeatures(
  issues: readonly Issue[],
  containerTypes: readonly string[] | undefined,
  watched: (issue: Issue) => boolean,
  maxChildren: number,
): SequenceableFeature[] {
  const out: SequenceableFeature[] = [];
  for (const group of featureGroups(issues, containerTypes, watched)) {
    if (group.children.length < 2 || group.children.length > maxChildren) continue;
    out.push({ ...group, key: featureSequenceKey(group.members, linkEdges(group.children)) });
  }
  return out;
}

export function featureSequenceOrigin(featureNumber: number): string {
  return `issue:${featureNumber}:sequence`;
}

export function featureSequenceSubmitOrigin(
  originRef: string | null,
): { ok: true; featureOrigin: string; featureNumber: number } | { ok: false; error: string } {
  const match = originRef ? /^issue:(\d+):sequence$/.exec(originRef) : null;
  if (match) {
    const number = Number(match[1]);
    return { ok: true, featureOrigin: `issue:${number}`, featureNumber: number };
  }
  return {
    ok: false,
    error:
      `sequence_submit is only for the agent dispatched to order the stories under a Feature, and this task's ` +
      `origin is ${originRef ?? '(none)'}. If you were sent to say where a Feature stands, use feature_summary; ` +
      `if you are decomposing one issue into parts, use plan_submit — a sequence orders issues somebody else ` +
      `already wrote and creates nothing.`,
  };
}

const MAX_REASON = 2_000;
const MAX_EDGE_REASON = 400;

interface SequenceSubmission {
  reason: string;
  unsure: string | null;
  edges: { issue: number; dependsOn: number; source: 'inferred'; reason: string | null }[];
}

export function validateSequenceSubmission(
  args: Record<string, unknown>,
  children: readonly number[],
): { ok: true; submission: SequenceSubmission } | { ok: false; error: string } {
  const reason = text(args.reason);
  if (!reason) {
    return {
      ok: false,
      error:
        'reason is required: one paragraph on why this order, in your own voice. An order with no stated reason ' +
        'is one nobody can agree or disagree with.',
    };
  }
  const raw = args.order;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'order must be a list of { issue, waitsOn, why } entries — one per story that waits on another. A story ' +
        'you do not list waits on nothing and is in the first wave, so an empty list is how you say the stories ' +
        'are independent.',
    };
  }
  const known = new Set(children);
  const edges: SequenceSubmission['edges'] = [];
  const seen = new Set<string>();
  for (const entry of raw as Record<string, unknown>[]) {
    const issue = Number(entry?.issue);
    if (!known.has(issue)) {
      return {
        ok: false,
        error:
          `order names #${entry?.issue}, which is not one of this Feature's stories. Its stories are: ` +
          `${children.map((c) => `#${c}`).join(', ') || 'none'}. An order may only rank the items you were shown.`,
      };
    }
    const waitsOn = Array.isArray(entry.waitsOn) ? entry.waitsOn : [];
    const why = text(entry.why);
    for (const on of waitsOn.map(Number)) {
      if (on === issue) {
        return { ok: false, error: `#${issue} cannot wait on itself. Drop the entry, or name what it waits on.` };
      }
      if (!known.has(on)) {
        return {
          ok: false,
          error:
            `order says #${issue} waits on #${on}, which is not one of this Feature's stories. Ordering across ` +
            'Features is not something the harness does — the unit somebody accepts an order for is the Feature ' +
            'they opened.',
        };
      }
      const key = `${issue}>${on}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        issue,
        dependsOn: on,
        source: 'inferred',
        reason: why === null ? null : why.slice(0, MAX_EDGE_REASON),
      });
    }
  }
  const cycle = findCycle(edges);
  if (cycle) {
    return {
      ok: false,
      error:
        `These edges form a cycle: ${cycle.map((n) => `#${n}`).join(' → ')}. Nothing was stored. One of those ` +
        'edges is the wrong way round, or the two stories genuinely can go together — say so by leaving the edge ' +
        'out, which is what "these are independent" looks like in an order.',
    };
  }
  return {
    ok: true,
    submission: { reason: reason.slice(0, MAX_REASON), unsure: text(args.unsure), edges },
  };
}

function text(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

export function resequenceVerdict(
  previous: {
    status: 'proposed' | 'accepted' | 'declined';
    edges: readonly { issue: number; dependsOn: number }[];
    members: readonly number[] | null;
  } | null,
  proposed: readonly { issue: number; dependsOn: number }[],
  members: readonly number[],
): { carry: false } | { carry: true; added: number[] } {
  if (previous === null || previous.status !== 'accepted' || previous.members === null) return { carry: false };
  const before = new Set(previous.members);
  const added = members.filter((n) => !before.has(n));
  const now = new Set(members);
  const key = (e: { issue: number; dependsOn: number }): string => `${e.issue}>${e.dependsOn}`;
  const kept = new Set(proposed.map(key));
  for (const edge of previous.edges) {
    if (!now.has(edge.issue) || !now.has(edge.dependsOn)) continue;
    if (!kept.has(key(edge))) return { carry: false };
  }
  const was = new Set(previous.edges.map(key));
  const isNew = new Set(added);
  for (const edge of proposed) {
    if (was.has(key(edge))) continue;
    if (!isNew.has(edge.issue) && !isNew.has(edge.dependsOn)) return { carry: false };
  }
  return { carry: true, added };
}
