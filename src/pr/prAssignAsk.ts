import type { ActionSink, PrAssignSink } from '../sink/actionSink.js';
import type { ErrorLog } from '../errorLog.js';
import type { PrReviewState } from '../review/prReviewState.js';
import type { Store } from '../store/store.js';
import type { PrAssignment } from '../store/prAssignAsks.js';
import type { PrPerson, PullRequest } from '../types.js';
import { allCommentsHandled } from '../review/prReview.js';
import { isOurPr, sameIdentity } from './prOwnership.js';

// → docs/spec/07-pull-requests.md#asking-who-should-look-at-it

const SHORTLIST_SIZE = 4;
const HISTORY_DEPTH = 100;

/** What the snapshot already knows about one open pull request, and the ask reads. */
interface AssignAskFacts {
  review: PrReviewState | null | undefined;
  fleetOnIt: boolean;
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
  const selves = [operator ?? '', pr.author ?? ''];
  return selves.some((self) => sameIdentity(self, person.id) || sameIdentity(self, person.name));
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
  const sightings = [
    ...mine.flatMap((pr) =>
      (pr.assignees ?? [])
        .filter((p) => !isOperator(p, pr, operator))
        .map((person) => ({ person, prNumber: pr.number })),
    ),
    ...answers,
  ].sort((a, b) => a.prNumber - b.prNumber);
  const seen = new Map<string, { person: PrPerson; prs: Set<number>; latest: number }>();
  for (const { person, prNumber } of sightings) {
    const entry = seen.get(person.id) ?? { person, prs: new Set<number>(), latest: prNumber };
    entry.prs.add(prNumber);
    entry.person = person;
    entry.latest = prNumber;
    seen.set(person.id, entry);
  }
  return [...seen.values()]
    .sort((a, b) => b.prs.size - a.prs.size || b.latest - a.latest)
    .slice(0, SHORTLIST_SIZE)
    .map((e) => e.person);
}

type AssignOutcome = { ok: true } | { ok: false; refusal: string };

const ALREADY_ANSWERED: AssignOutcome = { ok: false, refusal: 'this ask was already answered' };

export class PrAssignDesk {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly opts: {
      store: Store;
      sink: ActionSink & Partial<PrAssignSink>;
      errors: ErrorLog;
      operator: string | undefined;
      prAuthorConfigured: boolean;
    },
  ) {}

  private assigner(): PrAssignSink['assignPr'] | undefined {
    const { sink } = this.opts;
    return sink.canAssignPr?.() === true ? sink.assignPr?.bind(sink) : undefined;
  }

  private ours(pr: PullRequest): boolean {
    return isOurPr(pr, this.opts.prAuthorConfigured);
  }

  private shortlist(open: readonly PullRequest[], archived: readonly PullRequest[]): PrPerson[] {
    const mine = [...open, ...archived.slice(0, HISTORY_DEPTH)].filter((pr) => this.ours(pr));
    return assignShortlist(mine, this.opts.store.prAssignAsks.assignments(), this.opts.operator);
  }

  /**
   * The shortlist each due pull request is offered. The cheap per-PR gates run first, so the
   * common snapshot — nothing due — reads no history at all.
   */
  asks(
    open: readonly PullRequest[],
    archived: readonly PullRequest[],
    factsOf: (pr: PullRequest) => AssignAskFacts,
  ): ReadonlyMap<number, PrPerson[]> {
    const candidates = open.filter((pr) => this.candidate(pr, factsOf(pr)));
    if (candidates.length === 0 || this.assigner() === undefined) return new Map();
    const answered = this.opts.store.prAssignAsks.answeredPrs();
    const due = candidates.filter((pr) => !answered.has(pr.number));
    if (due.length === 0) return new Map();
    const shortlist = this.shortlist(open, archived);
    return shortlist.length === 0 ? new Map() : new Map(due.map((pr) => [pr.number, shortlist]));
  }

  private candidate(pr: PullRequest, facts: AssignAskFacts): boolean {
    if (!this.ours(pr) || pr.merged === true || (pr.state !== undefined && pr.state !== 'open')) return false;
    if (facts.fleetOnIt) return false;
    if (pr.assignees === undefined || pr.assignees.some((p) => !isOperator(p, pr, this.opts.operator))) return false;
    return allCommentsHandled(pr) && reviewDone(facts.review);
  }

  async assign(prNumber: number, personId: string, open: readonly PullRequest[]): Promise<AssignOutcome> {
    const { store, errors } = this.opts;
    const assignPr = this.assigner();
    if (assignPr === undefined)
      return { ok: false, refusal: 'the tracker this harness is connected to cannot assign pull requests' };
    const pr = open.find((p) => p.number === prNumber);
    if (pr === undefined || !this.ours(pr))
      return { ok: false, refusal: 'the ask is only for the fleet’s own pull requests' };
    if (this.settled(prNumber)) return ALREADY_ANSWERED;
    const person = this.shortlist(open, store.prArchive.listArchivedPrs(HISTORY_DEPTH)).find((p) => p.id === personId);
    if (person === undefined) return { ok: false, refusal: 'that person is not on the shortlist' };
    this.inFlight.add(prNumber);
    try {
      const sent = await assignPr({ prNumber, personId });
      if (!sent.ok) {
        errors.record({ source: 'provider', message: `assigning PR #${prNumber} was refused by the tracker` });
        return { ok: false, refusal: 'the tracker did not take the assignment' };
      }
    } catch (err) {
      errors.record({ source: 'provider', message: `assigning PR #${prNumber} failed: ${(err as Error).message}` });
      return { ok: false, refusal: `the tracker refused: ${(err as Error).message}` };
    } finally {
      this.inFlight.delete(prNumber);
    }
    store.prAssignAsks.recordAssignAnswer(prNumber, { answer: 'assigned', person });
    return { ok: true };
  }

  decline(prNumber: number): AssignOutcome {
    if (this.settled(prNumber)) return ALREADY_ANSWERED;
    this.opts.store.prAssignAsks.recordAssignAnswer(prNumber, { answer: 'declined' });
    return { ok: true };
  }

  private settled(prNumber: number): boolean {
    return this.inFlight.has(prNumber) || this.opts.store.prAssignAsks.isAnswered(prNumber);
  }
}
