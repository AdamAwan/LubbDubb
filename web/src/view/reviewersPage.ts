import type { AppState, OpenPullRequest, PrPerson } from '../types.js';
import type { NeedRow } from './needsYou.js';
import { assignAskOf, type AssignAsk } from './askGroups.js';
import { goalOfPr } from './goalRefs.js';

// → docs/spec/17-cockpit.md#every-reviewer-ask-is-one-page

export interface ReviewerStanding {
  person: PrPerson;
  /** Open pull requests the tracker already has them on. */
  open: number;
  /** They are on, or wrote, another pull request in the same stack. */
  knows: boolean;
}

interface ReviewerRung {
  ask: AssignAsk;
  /** Below the shallowest ask drawn, so a tie never hangs from a rung the page leaves out. */
  depth: number;
  /** Its own goal, drawn only in the unstacked group, which gathers asks from any goal. */
  goal: string | null;
  people: ReviewerStanding[];
}

export interface ReviewerGroup {
  /** The stack's ref, or null for the pull requests stacked on nothing. */
  stack: string | null;
  /** The stack's goal; null for the unstacked group, whose rungs carry their own. */
  goal: string | null;
  rungs: ReviewerRung[];
  /** Everyone any of its pull requests shortlists, those who know the stack first. */
  people: ReviewerStanding[];
}

export function reviewerAsks(rows: readonly NeedRow[], state: AppState): AssignAsk[] {
  return rows.flatMap((row) => {
    const ask = assignAskOf(row, state);
    return ask === null ? [] : [ask];
  });
}

interface Placed {
  ask: AssignAsk;
  depth: number;
  stackPrs: readonly OpenPullRequest[];
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

function stackIndex(state: AppState): Map<number, { ref: string; depth: number; prs: OpenPullRequest[] }> {
  const byNumber = new Map(state.world.pullRequests.map((pr) => [pr.number, pr]));
  const stackOf = new Map<number, { ref: string; depth: number; prs: OpenPullRequest[] }>();
  for (const stack of state.stacks ?? []) {
    const prs = stack.rungs.flatMap((r) => byNumber.get(r.prNumber) ?? []);
    for (const rung of stack.rungs)
      if (!stackOf.has(rung.prNumber)) stackOf.set(rung.prNumber, { ref: stack.ref, depth: rung.position - 1, prs });
  }
  return stackOf;
}

function knowsOne(person: PrPerson, pr: OpenPullRequest): boolean {
  return (
    same(pr.author, person.id) || same(pr.author, person.name) || (pr.assignees ?? []).some((a) => a.id === person.id)
  );
}

export function reviewerGroups(asks: readonly AssignAsk[], state: AppState): ReviewerGroup[] {
  const load = new Map<string, number>();
  for (const pr of state.world.pullRequests)
    for (const p of pr.assignees ?? []) load.set(p.id, (load.get(p.id) ?? 0) + 1);
  const stackOf = stackIndex(state);

  const byGroup = new Map<string | null, Placed[]>();
  for (const ask of asks) {
    const at = stackOf.get(ask.number);
    const placed = { ask, depth: at?.depth ?? 0, stackPrs: at?.prs ?? [] };
    byGroup.set(at?.ref ?? null, [...(byGroup.get(at?.ref ?? null) ?? []), placed]);
  }

  const standing = (person: PrPerson, others: readonly OpenPullRequest[]): ReviewerStanding => ({
    person,
    open: load.get(person.id) ?? 0,
    knows: others.some((pr) => knowsOne(person, pr)),
  });

  const groups = [...byGroup.entries()].map(([stack, placed]): ReviewerGroup => {
    placed.sort((a, b) => a.depth - b.depth || a.ask.number - b.ask.number);
    const top = placed[0]?.depth ?? 0;
    const rungs = placed.map(({ ask, depth, stackPrs }): ReviewerRung => {
      const others = stackPrs.filter((pr) => pr.number !== ask.number);
      return {
        ask,
        depth: depth - top,
        goal: stack === null ? goalOfPr(state, ask.number) : null,
        people: ask.assignAsk.map((p) => standing(p, others)),
      };
    });
    const seen = new Map<string, ReviewerStanding>();
    for (const s of rungs.flatMap((r) => r.people)) {
      const was = seen.get(s.person.id);
      seen.set(s.person.id, was === undefined ? s : { ...was, knows: was.knows || s.knows });
    }
    const people = [...seen.values()].sort((a, b) => Number(b.knows) - Number(a.knows));
    return { stack, goal: stack === null ? null : goalOfPr(state, rungs[0]!.ask.number), rungs, people };
  });
  return groups.sort((a, b) => Number(a.stack === null) - Number(b.stack === null));
}

export function standingNote(s: ReviewerStanding): string {
  const load = s.open === 0 ? 'free' : `${s.open} open`;
  return s.knows ? `knows this stack · ${load}` : load;
}

/** Each person's note, by id, for the buttons that name them. */
export function notesOf(people: readonly ReviewerStanding[]): ReadonlyMap<string, string> {
  return new Map(people.map((s) => [s.person.id, standingNote(s)]));
}
