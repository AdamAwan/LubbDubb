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
}

export function sequenceReadiness(edges: readonly SequenceEdge[], world: SequenceWorld): Map<number, number[]> {
  if (edges.length === 0) return new Map();
  const byNumber = new Map(world.issues.map((i) => [i.number, i]));
  const satisfied = new Map<number, boolean>();
  const isSatisfied = (number: number): boolean => {
    const cached = satisfied.get(number);
    if (cached !== undefined) return cached;
    const issue = byNumber.get(number);
    const answer = issue === undefined || issue.state !== 'open' || openPrForIssue(issue, world.openPrs) !== null;
    satisfied.set(number, answer);
    return answer;
  };

  const waiting = new Map<number, number[]>();
  for (const edge of edges) {
    if (isSatisfied(edge.dependsOn)) continue;
    const held = waiting.get(edge.issue);
    if (held) {
      if (!held.includes(edge.dependsOn)) held.push(edge.dependsOn);
    } else waiting.set(edge.issue, [edge.dependsOn]);
  }
  for (const held of waiting.values()) held.sort((a, b) => a - b);
  return waiting;
}

export function sequenceHoldReason(waitingOn: readonly number[]): string {
  const list = waitingOn.map((n) => `#${n}`).join(', ');
  return waitingOn.length === 1
    ? `Held: waits on ${list}, which has not pushed a branch yet.`
    : `Held: waits on ${list}, none of which has pushed a branch yet.`;
}
