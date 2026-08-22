import type { KnowledgeFactView, KnowledgeGraduationView } from '../types.js';
import type { Place } from './place.js';

/**
 * How the Knowledge page is grouped, narrowed and ordered — the arithmetic behind
 * the surface, kept out of the panel so it can be asserted.
 *
 * `KnowledgePanel.tsx` is a module no test can import, which is the same reason
 * `statePick` and `widenedFor` live in `place.ts` rather than in the tickets panel.
 * Everything here is a pure function of a fact and a place; nothing here decides
 * anything about a claim, and nothing here is a second opinion about a reading the
 * server already took. → `docs/spec/27-knowledge.md#in-the-cockpit`
 */

/**
 * How the page is drawn, narrowed and ordered — every field of it a `Place` field,
 * named off `Place` rather than re-spelled so the two cannot drift.
 *
 * The panel is handed this rather than reading the place itself, for the tickets
 * tab's reason: a component that is *told* where it is can be rendered by a test
 * with no address bar anywhere near it.
 */
export interface KnowledgeQuery {
  view: Place['knowledgeView'];
  show: Place['knowledgeShow'];
  sort: Place['knowledgeSort'];
  desc: Place['knowledgeDesc'];
  open: Place['knowledgeOpen'];
}

/**
 * A heading on the page, in the order things demand attention.
 *
 * The order is not the state machine's — it is the order an operator meets them:
 * the notices with clocks on them, the corroborated claims waiting on the one
 * decision that is theirs, then what is reaching agents now, then the long tails.
 *
 * **`tail` is folded until asked for, and that is the whole of the density change.**
 * A tail is a list an operator reads when they go looking for it, so it costs one
 * line until they do — while every group that reaches an agent stays open, because
 * a page that hides what the fleet is being told is not a governance surface.
 */
interface KnowledgeGroup {
  /** Stable, and in the address bar once an operator opens a tail — never re-spelled. */
  id: string;
  title: string;
  /**
   * What the heading used to say in a paragraph under it, said in a tooltip now.
   *
   * The words are not the cost the page was paying — nine paragraphs of them
   * between an operator and the eleven rows they came to rule on were. Kept in
   * full rather than trimmed, because each states an invariant that is stated
   * nowhere else on the glass.
   */
  blurb: string;
  tail: boolean;
}

export const KNOWLEDGE_GROUPS: readonly KnowledgeGroup[] = [
  {
    id: 'notices',
    title: 'Live notices',
    blurb:
      'Expiring observations, with the clock they were filed under. A notice states what was seen and never what to do about it; the agent draws the conclusion. These are the one thing agreement alone puts in front of every agent — two goals seeing the same thing is enough, and what makes that safe is that each one ends by itself. The harness raises its own for a check that went red and green on one commit, and for a check red on a branch other pull requests are based on; it reads those rather than being told them, so it counts as an observer.',
    tail: false,
  },
  {
    id: 'needsYou',
    title: 'Needs you',
    blurb:
      'Two agents on two different goals saw the same thing, which is as far as agreement can carry a claim. What is left is yours: put it in front of every agent, leave it here to be asked for, or say it is not true.',
    tail: false,
  },
  {
    id: 'injected',
    title: 'Injected',
    blurb:
      "In every agent's system prompt before it reads any code — vouched for by you, or a notice two goals saw. Everything here rides the block whatever its scope, because a claim about one check is for the agent about to run it as much as for the one sent to fix it. The exception is a goal claim: it dies with its goal, so it rides that goal's own dispatches instead.",
    tail: false,
  },
  {
    id: 'lookup',
    title: 'On lookup',
    blurb:
      'True, and answered when an agent asks. This is where a claim that is not worth every agent’s context belongs — it costs nothing until somebody wants it. Each row carries how often it was actually asked for, which is the one signal an injected claim cannot have: there is no way to measure whether a line in every agent’s prompt was read, and this page does not pretend there is. Nothing is demoted for want of demand.',
    tail: true,
  },
  {
    id: 'proposal',
    title: 'One voice',
    blurb:
      'One agent said it and nothing has agreed. These reach nobody and cost nothing; they are here because the second agent to hit the same wall is what moves them, and because you can rule on one now if you already know.',
    tail: true,
  },
  {
    id: 'committed',
    title: 'Committed to the repository',
    blurb:
      'In the repository now, and out of every prompt: an agent reads these from the tree, and keeping them injected would pay context twice for one sentence. Each row carries the pull request that put it there — a claim only reaches this section when that pull request actually merged, never when the work was queued. This list growing while Injected shrinks is the number worth watching.',
    tail: true,
  },
  {
    id: 'superseded',
    title: 'Superseded',
    blurb:
      'Replaced. An agent said one of these was contradicted by the code in front of it, wrote what it should say instead, and you adopted that amendment — so this wording is out of every prompt while its row stays saying what it said. Not rejected: it was not judged untrue, and a rejection would bar the sharper claim’s own words, since an amendment contains the claim it sharpens.',
    tail: true,
  },
  {
    id: 'retired',
    title: 'Retired',
    blurb:
      'Not carried any more, and never judged untrue — the check it was about is gone, the seam it described was refactored away, the fleet moved on. Drawn rather than dropped, so a list you have finished with can be told from one that lost rows. An agent that hits the same wall may raise it again, which files a fresh claim with its own evidence and today’s date rather than resurrecting this judgement: a claim worth bringing back is worth reading first.',
    tail: true,
  },
  {
    id: 'rejected',
    title: 'Rejected',
    blurb:
      'Not true, and barred from coming back: a re-proposal of one of these is refused by name. Drawn rather than dropped, because a surface that shows only what it let through cannot show you what it stopped. Terminal — the way back is an agent filing an amendment that names the claim.',
    tail: true,
  },
];

/**
 * Which heading a claim sits under — its reach, with the two readings the reach
 * word alone does not carry.
 *
 * A **live** expiring claim is a notice wherever its reach puts it, and a lapsed
 * one falls back to that reach rather than vanishing: the row still says what it
 * said. A `lookup` claim nobody has ruled on is **Needs you**, which is the whole
 * of that heading — the store carried it there on two corroborations, and the
 * decision left is the operator's.
 *
 * **A claim is in exactly one group, and it is the one its reach names.** Nothing
 * here lifts a disputed claim, a drifted scope or a claim nobody asked for out of
 * the group it belongs to: that would draw a demotion that did not happen, which
 * is the invariant the page exists to state. What those readings move is the
 * *filter*, not the row. → `docs/spec/27-knowledge.md#in-the-cockpit`
 */
export function groupFor(fact: KnowledgeFactView, now: number): string {
  const live = fact.expiresAt === null || new Date(fact.expiresAt).getTime() > now;
  if (fact.lifetime === 'expiring' && fact.reach !== 'rejected' && fact.reach !== 'retired' && live) return 'notices';
  if (fact.reach === 'lookup' && fact.ruledAt === null) return 'needsYou';
  return fact.reach;
}

/**
 * Why this claim is waiting on a person, or null — the page's one computed
 * reading, and the only thing on it that crosses a reach boundary.
 *
 * It crosses one because *waiting on you* is not a place a claim sits: an
 * unanswered dispute is on an injected claim, a cap drop is on an injected claim,
 * an unknown graduation is on whatever the claim was when somebody committed it,
 * and a corroborated claim nobody has ruled on is at `lookup`. Four states, one
 * question — and an operator who has to visit four headings to answer it answers
 * three of them.
 *
 * **It narrows and it never moves.** The reason is drawn on the row where the row
 * already is; the filter it feeds shows fewer rows and never re-homes one. That
 * distinction is the whole of why this is a predicate and not a tenth group.
 *
 * Settled reaches are excluded, and each for its own reason: a rejection is
 * terminal and a superseded wording has a sharper claim standing in its place, so
 * a dispute against either is not a thing anybody can act on. `committed` stays
 * in, because the reading that asks for an answer — a pull request that left the
 * world unseen — is the one that put it there.
 */
export function waitingOn(
  fact: KnowledgeFactView,
  graduation: KnowledgeGraduationView | null,
  dropped: ReadonlySet<string>,
): string | null {
  if (fact.reach === 'rejected' || fact.reach === 'superseded' || fact.reach === 'retired') return null;
  if (graduation !== null && graduation.reading === 'unknown') {
    return 'Its documentation pull request left the world without ever being seen closed, and the harness will not guess which way it went.';
  }
  if (fact.openContradictions > 0) {
    return `${fact.openContradictions === 1 ? 'A dispute is' : `${fact.openContradictions} disputes are`} unanswered, and the claim goes on reaching every agent it already reached until you answer.`;
  }
  if (fact.reach === 'lookup' && fact.ruledAt === null) {
    return 'Two agents on two different goals saw this, which is as far as agreement can carry it. The rest is yours.';
  }
  if (dropped.has(fact.id)) {
    return 'Over the block’s character cap, so no agent reads it. Demote a newer injected claim to make room.';
  }
  if (fact.scopeStale) {
    return 'Nothing has matched its scope lately and the provider reports no check by that name, so it is reaching nobody.';
  }
  return null;
}

/**
 * Whether a claim survives the page's narrowing.
 *
 * Four coarse answers rather than a facet per reading, for the tickets tab's
 * reason ([17](../../../docs/spec/17-cockpit.md)): the question an operator arrives
 * with is *what is on me*, *what is the fleet being told*, or *what did we settle* —
 * and a filter row with nine chips on it is a second copy of the headings.
 */
export function inShow(show: KnowledgeQuery['show'], fact: KnowledgeFactView, waiting: string | null): boolean {
  if (show === 'all') return true;
  if (show === 'waiting') return waiting !== null;
  if (show === 'reaching') return fact.reach === 'injected' || fact.reach === 'lookup';
  return (
    fact.reach === 'committed' || fact.reach === 'superseded' || fact.reach === 'retired' || fact.reach === 'rejected'
  );
}

/** Where a group sits on the page, for the table's `reach` column to sort by. */
const groupRank = (fact: KnowledgeFactView, now: number): number =>
  KNOWLEDGE_GROUPS.findIndex((g) => g.id === groupFor(fact, now));

/**
 * The table's order.
 *
 * Every key is a reading the server already took — the corroboration count is
 * `distinctCorroborators`', the ask count is the store's — so this arranges them
 * and computes none of them. Ties fall back to age so one ordering has one
 * spelling: a sort by a column where half the rows read zero is otherwise free to
 * come out differently on every poll, which reads as rows moving by themselves.
 */
export function sortFacts(
  facts: readonly KnowledgeFactView[],
  now: number,
  sort: KnowledgeQuery['sort'],
  desc: boolean,
): KnowledgeFactView[] {
  const key = (fact: KnowledgeFactView): number | string => {
    switch (sort) {
      case 'claim':
        return fact.claim.toLowerCase();
      case 'scope':
        return fact.scope;
      case 'observers':
        return fact.corroborations;
      case 'disputes':
        return fact.contradictions;
      case 'asks':
        return fact.asks;
      case 'age':
        return new Date(fact.createdAt).getTime();
      default:
        return groupRank(fact, now);
    }
  };
  const age = (fact: KnowledgeFactView): number => new Date(fact.createdAt).getTime();
  return [...facts].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    // The direction is the column's and never the tie-break's. Negating both puts
    // rows that read the same — every zero in a count column, which is most of
    // them — in one order at one end and the reverse at the other, which on a page
    // that polls reads as rows moving by themselves.
    if (x !== y) return (x > y ? 1 : -1) * (desc ? -1 : 1);
    return age(b) - age(a);
  });
}

/**
 * Where a click on a column heading lands.
 *
 * A new column opens on the direction that column is worth reading in — most
 * disputed, most asked for, newest — rather than on ascending, which for every
 * count on this page is a screen of zeroes. Clicking the column already sorted
 * flips it, which is the only way back to the other end.
 */
export function nextSort(
  current: KnowledgeQuery['sort'],
  desc: boolean,
  key: KnowledgeQuery['sort'],
): { knowledgeSort: KnowledgeQuery['sort']; knowledgeDesc: boolean } {
  if (current === key) return { knowledgeSort: key, knowledgeDesc: !desc };
  const countsDown = key === 'observers' || key === 'disputes' || key === 'asks' || key === 'age';
  return { knowledgeSort: key, knowledgeDesc: countsDown };
}
