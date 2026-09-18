import type { Issue, PullRequest } from '../types.js';
import { openPrForIssue } from '../dispatcher/issuePickup.js';

// → docs/spec/33-story-sequencing.md

export type IssueSequencing = 'off' | 'links' | 'full';

export interface SequenceEdge {
  issue: number;
  dependsOn: number;
}

export function linkEdges(issues: readonly Issue[]): SequenceEdge[] {
  const edges: SequenceEdge[] = [];
  for (const issue of issues) {
    for (const dep of issue.dependsOn ?? []) {
      if (dep.number !== issue.number) edges.push({ issue: issue.number, dependsOn: dep.number });
    }
  }
  return edges;
}

interface SequenceWorld {
  issues: readonly Issue[];
  openPrs: PullRequest[];
  /**
   * Whether a predecessor is one the fleet will ever work. Omitted means yes for all, which is the
   * reading every caller had before an order could cover an unwatched story.
   */
  watched?: (issue: Issue) => boolean;
}

/**
 * What a story is waiting on, and which of those nothing is going to deliver.
 *
 * `unworkable` is a subset of `on`: a predecessor that is open, has pushed nothing, and carries no
 * watch tag. It holds exactly as the others do — that is the operator's instruction, not an
 * oversight — and it is carried separately only so the hold can say the one thing that distinguishes
 * it: waiting will not end this. → docs/spec/33-story-sequencing.md#an-unwatched-predecessor-holds
 */
export interface SequenceWait {
  on: number[];
  unworkable: number[];
}

export function sequenceReadiness(edges: readonly SequenceEdge[], world: SequenceWorld): Map<number, SequenceWait> {
  if (edges.length === 0) return new Map();
  const byNumber = new Map(world.issues.map((i) => [i.number, i]));
  const watched = world.watched ?? ((): boolean => true);
  const verdicts = new Map<number, 'satisfied' | 'waiting' | 'unworkable'>();
  const verdictOf = (number: number): 'satisfied' | 'waiting' | 'unworkable' => {
    const cached = verdicts.get(number);
    if (cached !== undefined) return cached;
    const issue = byNumber.get(number);
    const answer =
      issue === undefined || issue.state !== 'open' || openPrForIssue(issue, world.openPrs) !== null
        ? 'satisfied'
        : watched(issue)
          ? 'waiting'
          : 'unworkable';
    verdicts.set(number, answer);
    return answer;
  };

  const waiting = new Map<number, SequenceWait>();
  for (const edge of edges) {
    const verdict = verdictOf(edge.dependsOn);
    if (verdict === 'satisfied') continue;
    const held = waiting.get(edge.issue) ?? { on: [], unworkable: [] };
    if (!held.on.includes(edge.dependsOn)) held.on.push(edge.dependsOn);
    if (verdict === 'unworkable' && !held.unworkable.includes(edge.dependsOn)) held.unworkable.push(edge.dependsOn);
    waiting.set(edge.issue, held);
  }
  for (const held of waiting.values()) {
    held.on.sort((a, b) => a - b);
    held.unworkable.sort((a, b) => a - b);
  }
  return waiting;
}

export function sequenceHoldReason(wait: SequenceWait): string {
  const list = (numbers: readonly number[]): string => numbers.map((n) => `#${n}`).join(', ');
  const head =
    wait.on.length === 1
      ? `Held: waits on ${list(wait.on)}, which has not pushed a branch yet.`
      : `Held: waits on ${list(wait.on)}, none of which has pushed a branch yet.`;
  if (wait.unworkable.length === 0) return head;
  return (
    `${head} ${list(wait.unworkable)} ` +
    `${wait.unworkable.length === 1 ? 'carries' : 'carry'} no watch tag, so nothing is going to work ` +
    `${wait.unworkable.length === 1 ? 'it' : 'them'} and this wait does not end on its own — tag ` +
    `${wait.unworkable.length === 1 ? 'it' : 'them'}, or amend the order.`
  );
}
