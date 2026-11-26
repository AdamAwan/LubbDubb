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
  depth: number;
  people: ReviewerStanding[];
}

export interface ReviewerGroup {
  /** The stack's ref, or null for the pull requests stacked on nothing. */
  stack: string | null;
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

export function reviewerGroups(asks: readonly AssignAsk[], state: AppState): ReviewerGroup[] {
  const open = state.world.pullRequests;
  const load = new Map<string, number>();
  for (const pr of open) for (const p of pr.assignees ?? []) load.set(p.id, (load.get(p.id) ?? 0) + 1);

  const stackOf = new Map<number, { ref: string; members: number[]; position: number }>();
  for (const stack of state.stacks ?? []) {
    const members = stack.rungs.map((r) => r.prNumber);
    stack.rungs.forEach((rung, i) => {
      if (!stackOf.has(rung.prNumber)) stackOf.set(rung.prNumber, { ref: stack.ref, members, position: i });
    });
  }

  const byGroup = new Map<string | null, { ask: AssignAsk; position: number; members: number[] }[]>();
  for (const ask of asks) {
    const at = stackOf.get(ask.number);
    const key = at?.ref ?? null;
    const list = byGroup.get(key) ?? [];
    list.push({ ask, position: at?.position ?? 0, members: at?.members ?? [] });
    byGroup.set(key, list);
  }

  const standing = (person: PrPerson, others: readonly OpenPullRequest[]): ReviewerStanding => ({
    person,
    open: load.get(person.id) ?? 0,
    knows: others.some(
      (pr) =>
        pr.author === person.id || pr.author === person.name || (pr.assignees ?? []).some((a) => a.id === person.id),
    ),
  });

  const groups = [...byGroup.entries()].map(([stack, members]): ReviewerGroup => {
    members.sort((a, b) => a.position - b.position || a.ask.number - b.ask.number);
    const rungs = members.map(({ ask, position, members: stackPrs }): ReviewerRung => {
      const others = open.filter((pr) => pr.number !== ask.number && stackPrs.includes(pr.number));
      return { ask, depth: stack === null ? 0 : position, people: ask.assignAsk.map((p) => standing(p, others)) };
    });
    const seen = new Map<string, ReviewerStanding>();
    for (const rung of rungs)
      for (const s of rung.people) {
        const was = seen.get(s.person.id);
        seen.set(s.person.id, was === undefined ? s : { ...was, knows: was.knows || s.knows });
      }
    const people = [...seen.values()].sort((a, b) => Number(b.knows) - Number(a.knows));
    const first = members[0]?.ask.number;
    return { stack, goal: first === undefined ? null : goalOfPr(state, first), rungs, people };
  });
  return groups.sort((a, b) => Number(a.stack === null) - Number(b.stack === null));
}

export function standingNote(s: ReviewerStanding): string {
  const load = s.open === 0 ? 'free' : `${s.open} open`;
  return s.knows ? `knows this stack · ${load}` : load;
}

export function reviewersLine(count: number): string {
  return count === 1 ? '1 pull request needs a reviewer' : `${count} pull requests need a reviewer`;
}
