import type { ActionSink, PrAssignSink } from '../sink/actionSink.js';
import type { ErrorLog } from '../errorLog.js';
import type { PrReviewState } from '../review/prReviewState.js';
import type { Store } from '../store/store.js';
import type { PrAssignment } from '../store/prAssignAsks.js';
import type { PrPerson, PullRequest } from '../types.js';
import { isOurPr } from './prOwnership.js';

// → docs/spec/07-pull-requests.md#asking-who-should-look-at-it

const SHORTLIST_SIZE = 4;
const HISTORY_DEPTH = 100;

interface AssignAskReading {
  pr: PullRequest;
  ours: boolean;
  answered: boolean;
  review: PrReviewState | null | undefined;
  fleetOnIt: boolean;
  operator: string | undefined;
}

export function assignAskDue(r: AssignAskReading): boolean {
  const { pr } = r;
  if (!r.ours || r.answered || pr.merged === true || (pr.state !== undefined && pr.state !== 'open')) return false;
  if (r.fleetOnIt) return false;
  if (pr.assignees === undefined || pr.assignees.some((p) => !isOperator(p, pr, r.operator))) return false;
  if (!pr.unresolvedComments.every((c) => c.handled)) return false;
  return reviewDone(r.review);
}

function reviewDone(review: PrReviewState | null | undefined): boolean {
  if (review === null || review === undefined) return true;
  switch (review.status) {
    case 'clear':
    case 'skipped':
    case 'elsewhere':
      return true;
    case 'findings':
      return review.addressed;
    case 'deciding':
    case 'routed':
      return false;
  }
}

function isOperator(person: PrPerson, pr: PullRequest, operator: string | undefined): boolean {
  const same = (a: string | undefined, b: string): boolean =>
    a !== undefined && a !== '' && a.toLowerCase() === b.toLowerCase();
  return [person.id, person.name].some((v) => same(operator, v) || same(pr.author, v));
}

/**
 * The people the operator's own pull requests have gone to, most often first. Everybody the tracker
 * has on one of them counts, so the list is learnt from what the operator already does there.
 */
export function assignShortlist(
  mine: readonly PullRequest[],
  answers: readonly PrAssignment[],
  operator: string | undefined,
): PrPerson[] {
  const seen = new Map<string, { person: PrPerson; prs: Set<number>; latest: number }>();
  const note = (person: PrPerson, prNumber: number): void => {
    const entry = seen.get(person.id) ?? { person, prs: new Set<number>(), latest: prNumber };
    entry.prs.add(prNumber);
    if (prNumber >= entry.latest) entry.person = person;
    entry.latest = Math.max(entry.latest, prNumber);
    seen.set(person.id, entry);
  };
  for (const pr of mine) {
    for (const person of pr.assignees ?? []) if (!isOperator(person, pr, operator)) note(person, pr.number);
  }
  for (const a of answers) note(a.person, a.prNumber);
  return [...seen.values()]
    .sort((a, b) => b.prs.size - a.prs.size || b.latest - a.latest)
    .slice(0, SHORTLIST_SIZE)
    .map((e) => e.person);
}

type AssignOutcome = { ok: true } | { ok: false; refusal: string };

export class PrAssignDesk {
  constructor(
    private readonly opts: {
      store: Store;
      sink: ActionSink & Partial<PrAssignSink>;
      errors: ErrorLog;
      operator: string | undefined;
      prAuthorConfigured: boolean;
    },
  ) {}

  canAssign(): boolean {
    return this.opts.sink.canAssignPr?.() === true && this.opts.sink.assignPr !== undefined;
  }

  ours(pr: PullRequest): boolean {
    return isOurPr(pr, this.opts.prAuthorConfigured);
  }

  answered(): ReadonlySet<number> {
    return this.opts.store.prAssignAsks.answeredPrs();
  }

  shortlist(open: readonly PullRequest[]): PrPerson[] {
    const { store, operator } = this.opts;
    const mine = [...open, ...store.prArchive.listArchivedPrs(HISTORY_DEPTH)].filter((pr) => this.ours(pr));
    return assignShortlist(mine, store.prAssignAsks.assignments(), operator);
  }

  async assign(prNumber: number, personId: string, open: readonly PullRequest[]): Promise<AssignOutcome> {
    const { sink, store, errors } = this.opts;
    if (!this.canAssign() || sink.assignPr === undefined)
      return { ok: false, refusal: 'the tracker this harness is connected to cannot assign pull requests' };
    const person = this.shortlist(open).find((p) => p.id === personId);
    if (person === undefined) return { ok: false, refusal: 'that person is not on the shortlist' };
    try {
      const sent = await sink.assignPr({ prNumber, personId });
      if (!sent.ok) return { ok: false, refusal: 'the tracker did not take the assignment' };
    } catch (err) {
      errors.record({ source: 'provider', message: `assigning PR #${prNumber} failed: ${(err as Error).message}` });
      return { ok: false, refusal: `the tracker refused: ${(err as Error).message}` };
    }
    store.prAssignAsks.recordAssignAnswer(prNumber, { answer: 'assigned', person });
    return { ok: true };
  }

  decline(prNumber: number): void {
    this.opts.store.prAssignAsks.recordAssignAnswer(prNumber, { answer: 'declined' });
  }
}
