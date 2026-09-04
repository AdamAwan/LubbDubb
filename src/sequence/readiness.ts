import type { Issue, PullRequest } from '../types.js';
import { openPrForIssue } from '../dispatcher/issuePickup.js';

/**
 * The order the stories under a Feature are worked in, and the hold that keeps a
 * story waiting for the one it needs. → `docs/spec/33-story-sequencing.md`
 *
 * Everything here is pure over the edges plus the world, which is the point: the
 * two things most likely to be wrong — which stories are ready, and what an
 * operator is told about the one that is not — are answerable with no harness.
 */

/**
 * How much ordering the operator has asked for.
 *
 * `links` is the level with **no inference in it at all**: the edges are the ones a
 * person drew on their own board, so the gate is deterministic, costs no agent
 * spend and has nothing to accept. `full` adds the sequencer, and does not exist
 * yet. `off` is the default, and holds nothing.
 */
export type IssueSequencing = 'off' | 'links' | 'full';

/** One "this waits on that", as the gate reads it. */
interface SequenceEdge {
  /** The issue that waits. */
  issue: number;
  /** The issue it waits on. */
  dependsOn: number;
}

/**
 * The edges the **provider itself** reports, from `Issue.dependsOn`.
 *
 * `undefined` and `[]` are deliberately not the same thing here either: a tracker
 * that carries no dependencies contributes nothing, and one that does contributes
 * an item's whole list. Either way this is re-read every hydration and never
 * stored — a person drew these, and the harness's job is to read them.
 */
export function linkEdges(issues: readonly Issue[]): SequenceEdge[] {
  const edges: SequenceEdge[] = [];
  for (const issue of issues) {
    for (const dep of issue.dependsOn ?? []) {
      // A self-edge is the one cycle a single item can state on its own, and it
      // would hold that item for good. Dropped rather than reported: there is
      // nothing for an operator to do about it here that they cannot do on the
      // board, and holding a story on it would be the failure this whole feature
      // exists to avoid.
      if (dep.number !== issue.number) edges.push({ issue: issue.number, dependsOn: dep.number });
    }
  }
  return edges;
}

/** The slice of the world a readiness verdict is formed against. */
interface SequenceWorld {
  /** The dispatch view's issues — an edge naming anything absent from this is ignored. */
  issues: readonly Issue[];
  /** Every open pull request, the hidden ones included (`openPrForIssue`'s contract). */
  openPrs: PullRequest[];
}

/**
 * For each issue an edge holds, the issues it is still waiting on — ascending, and
 * absent entirely when nothing holds it.
 *
 * **A predecessor is satisfied when it is settled, or when it is in flight and has
 * pushed a branch**, which is `dependencySatisfied`'s rule from `src/plans/parts.ts`
 * one tier up. Waiting for a merge would serialise a feature into a queue of one;
 * waiting for a branch lets the successor stack on work already underway, which is
 * what makes a four-wave sequence finish in less than four times one story. An open
 * pull request is how a *goal's* branch announces itself to the dispatcher, which
 * reads no git.
 *
 * Every uncertainty leaves the edge satisfied rather than holding: an edge naming
 * an issue the world does not hold is ignored, because a story invisible for a
 * pulse is not a story that has gone, and a hold that outlived its reason would
 * park a Feature with nothing red.
 */
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

/**
 * What the operator reads on a held row — appended to the rule's own reason, so
 * the row still says what the work *is* before it says why it is not going out.
 *
 * It names what the story waits behind rather than saying "sequenced", because the
 * queue's whole contract is that a held row explains itself: a word an operator has
 * to look up is the invisibility `capped` was introduced to fix, one indirection
 * further out.
 */
export function sequenceHoldReason(waitingOn: readonly number[]): string {
  const list = waitingOn.map((n) => `#${n}`).join(', ');
  return waitingOn.length === 1
    ? `Held: waits on ${list}, which has not pushed a branch yet.`
    : `Held: waits on ${list}, none of which has pushed a branch yet.`;
}
