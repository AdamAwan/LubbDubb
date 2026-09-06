import { createHash } from 'node:crypto';
import type { Issue, IssueRelative } from '../types.js';
import { isContainerIssue } from '../issueRelations.js';
import { linkEdges, type SequenceEdge } from './readiness.js';

/**
 * The pure half of story sequencing: which Features have an order to be written about,
 * what standing that order was written against, and whether a submitted set of edges is
 * an order at all. Reads no store, lens or world beyond the issue list it is handed.
 * → `docs/spec/33-story-sequencing.md`
 */

/** A Feature and the stories under it, as the sequencer is asked to order them. */
interface FeatureGroup {
  /** The container itself, as its children carry it — title and description included. */
  feature: IssueRelative;
  /** Its watched, **open** children — the ones an order is actually about. */
  children: Issue[];
  /**
   * Every watched child, settled ones included, ascending. The key digests this rather
   * than {@link children} — membership, not movement, so a merge does not re-propose.
   */
  members: number[];
}

/**
 * Group the world's stories under the Feature each hangs off, built from the children's
 * own `parent` — the container is usually not in the (tag- and assignee-narrowed) issue
 * list, and the parent summary is the only reliable source of its title and body. A
 * container that *is* in the list is skipped: an Epic's Features are not sequenced
 * against each other.
 * ([33](../../docs/spec/33-story-sequencing.md#what-is-deliberately-not-built))
 */
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

/**
 * What a Feature's order was written against — **membership, not movement**: which
 * stories are under the Feature and what the provider says about them, settled ones
 * included. A merge does not invalidate an order; an addition does. Sorted before
 * hashing so the key is order-independent.
 * → `docs/spec/33-story-sequencing.md#the-record`
 */
export function featureSequenceKey(members: readonly number[], edges: readonly SequenceEdge[]): string {
  const lines = [...members.map((n) => `c ${n}`), ...edges.map((e) => `e ${e.issue} ${e.dependsOn}`)].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}

/**
 * The cycle in these edges, as the stories on it, or null when there is none. Refused at
 * ingestion with nothing stored, never linearised on read — a silently untangled cycle
 * would hold work in an order nobody chose. Returns the cycle so the submitting agent
 * can act on it.
 */
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

/**
 * Above this many stories a Feature is not sequenced: the prompt would not fit and
 * the order would not be read. Forty is generous — a Feature nobody could hold in
 * their head is one an order would not make legible either.
 */
export const DEFAULT_SEQUENCE_MAX_CHILDREN = 40;

/** A Feature the sequencer could be asked about, with the standing its order answers. */
export interface SequenceableFeature extends FeatureGroup {
  /** `featureSequenceKey` over this group — membership, never movement. */
  key: string;
}

/**
 * The Features worth asking the sequencer about, with the key each order would be written
 * against. Both cuts — fewer than two stories, more than `maxChildren` — are refusals to
 * spend, and both fail open: the Feature keeps the ordering it has, which is none. The
 * key folds in the provider's own edges as well as membership, so a hand-drawn link
 * re-asks.
 */
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

/** The origin rule `feature-sequence` dispatches its desk agent on. */
export function featureSequenceOrigin(featureNumber: number): string {
  return `issue:${featureNumber}:sequence`;
}

/**
 * The reverse, for the submit side: which Feature this caller may write an order for,
 * decided by what it was dispatched to do rather than by what it says — the Feature is on
 * the origin, never an argument.
 * ([11](../../docs/spec/11-mcp-tools.md#identity))
 */
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

/** The longest reason the record will hold. Past it the card stops being readable. */
const MAX_REASON = 2_000;
/** Per edge — one line on why, not an argument. */
const MAX_EDGE_REASON = 400;

/** An order as the sequencer states it: one entry per story that waits on something. */
interface SequenceSubmission {
  reason: string;
  unsure: string | null;
  edges: { issue: number; dependsOn: number; source: 'inferred'; reason: string | null }[];
}

/**
 * Validate a submitted order against the Feature's own children. Three refusals, each of
 * something that would otherwise be stored and then hold work forever: an unknown story,
 * a self-edge, and a cycle (named back, so the submitter can fix it). Nothing is stored
 * on any of them.
 */
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

/**
 * What a re-proposed order does to the acceptance that stood: carry it, or ask again.
 * → `docs/spec/33-story-sequencing.md#a-story-is-added`
 *
 * The acceptance carries only when the new order is the old one *extended*: every
 * accepted edge between stories the Feature still has survives, and every new edge
 * touches a new story. Every uncertainty — an unaccepted previous order, `members` null
 * — falls through to a fresh `proposed`.
 */
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
  // Restricted to stories the Feature still has: an edge whose endpoint was re-parented
  // away is gone whatever the new order says.
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
