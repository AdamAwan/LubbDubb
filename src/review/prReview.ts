import type { PrReview, PrReviewRoute, PullRequest } from '../types.js';
import type { PrReviewPolicy } from './policy.js';

/**
 * The fleet's own read of a pull request, before a person is asked for theirs. Pure over
 * the world, the policy and the recorded rows; the two rules, the lens and the merge gate
 * all ask *these* functions rather than restating the predicate.
 * → `docs/spec/07-pull-requests.md#the-fleet-review`
 */

/**
 * The review's dispatch origin — its own, so the review carries its own cooldown and
 * attempt budget rather than spending the one a red build needs.
 */
export function reviewOrigin(prNumber: number): string {
  return `pr:${prNumber}:review`;
}

/**
 * Triage's origin, separate from the review's: one budget across both would let a routing
 * that cannot be got through cap a review that was never attempted.
 */
export function reviewTriageOrigin(prNumber: number): string {
  return `pr:${prNumber}:review-triage`;
}

/**
 * The read-only checkout the reviewer is given: a detached checkout *of* the pull
 * request's branch, never the branch itself. A reviewer holding the branch lease blocks
 * the CI fix behind it, and one that can commit reviews its own fix.
 */
export function reviewBranch(prNumber: number): string {
  return `review/pr-${prNumber}`;
}

/**
 * The pull request a `review_report` or `review_route` call is about, read from the
 * caller's own dispatch origin and never from an argument
 * ([11](docs/spec/11-mcp-tools.md)). Null for any other origin.
 */
export function reviewTargetPr(originRef: string | null, suffix: 'review' | 'review-triage'): number | null {
  if (originRef === null) return null;
  const match = new RegExp(`^pr:(\\d+):${suffix}$`).exec(originRef);
  return match ? Number(match[1]) : null;
}

/** The modes this project declared, in declaration order. */
export function reviewModeNames(policy: PrReviewPolicy): string[] {
  return Object.keys(policy.modes);
}

/**
 * Is there a routing decision to make at all? One mode is not a choice, so this is
 * switched on by there being two rather than by a flag that could disagree with them.
 */
export function routesBetweenModes(policy: PrReviewPolicy): boolean {
  return reviewModeNames(policy).length > 1;
}

/**
 * Does the triage run at all? Either question is enough: which mode ({@link
 * routesBetweenModes}), or whether to review at all (`allowSkip`). Every rule asks this
 * and never `routesBetweenModes`, which would silently give a skip-only project no
 * triage.
 */
export function triageRuns(policy: PrReviewPolicy): boolean {
  return routesBetweenModes(policy) || policy.allowSkip;
}

/**
 * Did the triage decide this pull request needs no review? Asked by `needsFleetReview`
 * *and* by `reviewSatisfied`, so a skip dispatches nothing and holds nothing. Honoured
 * only while `allowSkip` is on: turning it off falls every standing skip back to a review.
 */
export function reviewSkipped(route: PrReviewRoute | null, policy: PrReviewPolicy): boolean {
  return policy.allowSkip && route !== null && route.skipped;
}

/**
 * The mode a review runs in when nothing chose one — the fail-open target: a triage that
 * crashed or was capped costs a more careful read, never an unread pull request. A null
 * policy default takes the first declared mode, so a project declares its thorough mode
 * first.
 */
export function defaultReviewMode(policy: PrReviewPolicy): string | null {
  const names = reviewModeNames(policy);
  if (names.length === 0) return null;
  const named = policy.defaultMode;
  return named !== null && names.includes(named) ? named : (names[0] ?? null);
}

/**
 * The mode this pull request's review runs in: what triage chose, or the fail-open
 * default. Null on a project that declared no modes at all, which is the review
 * running on its rule's own profile with no charter.
 */
export function resolvedReviewMode(route: PrReviewRoute | null, policy: PrReviewPolicy): string | null {
  const names = reviewModeNames(policy);
  // A route naming a mode the project has since removed is not honoured: its charter
  // and profile are gone, so it falls back the way a triage failure does.
  if (route !== null && names.includes(route.mode)) return route.mode;
  return defaultReviewMode(policy);
}

/**
 * Does this pull request still want the fleet's review? One round, keyed on
 * the pull request, never the head SHA — a key that moved with the diff would
 * be invalidated by the first fix pushed after review, leaving the merge gate
 * unsatisfiable with nothing red. Also stands down for a PR reviewed outside
 * the harness, one the triage skipped, or one with unhandled human threads.
 */
export function needsFleetReview(pr: PullRequest, reading: PrReviewReading, policy: PrReviewPolicy): boolean {
  if (!policy.enabled) return false;
  if (pr.merged || reading.review !== null) return false;
  // The triage's own answer that nothing needs to read this one.
  if (reviewSkipped(reading.route, policy)) return false;
  // Somebody outside the harness already read it.
  if (reading.elsewhere.has(pr.number)) return false;
  return pr.unresolvedComments.every((c) => c.handled);
}

/**
 * Whether the merge gate is satisfied. Asks whether the review *happened*, not
 * whether it liked what it saw — with one round, gating on `clear` would wedge
 * every PR the reviewer had an opinion about. Unknown is never clear.
 */
export function reviewSatisfied(pr: PullRequest, reading: PrReviewReading, policy: PrReviewPolicy): boolean {
  if (!policy.enabled || !policy.blocking) return true;
  // Every arm `needsFleetReview` stands down on must release the gate here: a pull
  // request nothing will ever review must not be one nothing can merge.
  if (reviewSkipped(reading.route, policy)) return true;
  if (reading.elsewhere.has(pr.number)) return true;
  return reading.review !== null;
}

/** How the wait reads on a pull request's row while the review is still to come. */
export function reviewPendingLabel(mode: string | null): string {
  return mode === null ? 'not yet reviewed by the fleet' : `not yet reviewed by the fleet (${mode})`;
}

/** And while the harness is still deciding how to read it. */
export function triagePendingLabel(): string {
  return 'deciding how thoroughly to review it';
}

/**
 * What the reviewer is told to do with what it found, appended rather than interpolated.
 * Names `reply_to_review` explicitly, because an unqualified "post your findings" gets an
 * agent posting from its own shell under the operator's credential; off, it says
 * explicitly that nobody wants a comment.
 */
export function publishNote(publish: PrReviewPolicy['publish']): string {
  if (publish === 'none') {
    return (
      '\n\nDo not comment on the pull request. Your report through `review_report` is how this reaches ' +
      'the person who approves the merge; anything you post beside it is a second copy of it under ' +
      "somebody's name.\n"
    );
  }
  return (
    '\n\nAfter you report, post the same findings on the pull request with `reply_to_review` (omit the ' +
    'comment id — this is a comment on the pull request, not a reply to a thread). That tool is the only ' +
    'way you may write to it: the harness authorises what goes out and signs it as a machine, where a ' +
    "`gh` command from your shell posts under the operator's own name with nothing recording that it " +
    'happened. Report first — the comment is a copy of the record, not the record.\n'
  );
}

/**
 * What the triage is told about skipping, appended not interpolated. Empty
 * where the project did not allow it; where allowed, the wording pushes
 * against the skip since it also lets the merge through unread.
 */
export function skipNote(policy: PrReviewPolicy): string {
  if (!policy.allowSkip) return '';
  return (
    '\n\nThis project also lets you decide that a pull request needs **no review at all** — pass ' +
    '`skip: true` to `review_route` instead of a mode. Reach for it only where reading the diff could ' +
    'not change anything: a version bump, a regenerated lockfile, a typo in a comment or a string. ' +
    'Anything that changes behaviour, however small the diff, gets a mode. A skip also releases the ' +
    'merge gate, so it is the one answer of yours that lets a change through unread — and your reason ' +
    'is the only account of why, for whoever finds it later.\n'
  );
}

/**
 * The project's own words, appended verbatim under a heading that says whose they are.
 * Attributed rather than folded into the prompt's voice, so the agent can weigh them —
 * a charter that contradicts the repository is itself worth reporting.
 */
export function charterNote(charter: string | null, heading: string): string {
  const text = charter?.trim() ?? '';
  if (text === '') return '';
  return `\n\n## ${heading}\n\nThis is committed in the repository by the team that works here. Read it as their standing instruction, and say so if what you find contradicts it.\n\n${text}\n`;
}

/** The heading a mode's charter is appended under, naming the mode it belongs to. */
export function modeCharterHeading(mode: string | null): string {
  return mode === null
    ? 'What this project asks its reviewers to look at'
    : `What this project asks a "${mode}" review to look at`;
}

/**
 * The charters as the dispatcher holds them: text, never paths — nothing in a rule reads
 * the filesystem, so `src/review/charter.ts` reads the files once at boot.
 */
/**
 * Everything the review's two questions are asked of, gathered once per pulse. A bundle
 * rather than positional arguments, so a new arm reaches every caller or does not compile.
 */
export interface PrReviewReading {
  /** The fleet's own verdict, where it has one. */
  review: PrReview | null;
  /** How the triage said to read it — or that it should not be read at all. */
  route: PrReviewRoute | null;
  /**
   * Pull requests a check outside the harness reported already reviewed
   * (`pr_review_externals`). Empty where the operator configured no check.
   */
  elsewhere: ReadonlySet<number>;
}

/**
 * What the rows say about one pull request. Structurally typed rather than tied to
 * `StageContext`, so every caller gathers the reading the same way and cannot quietly
 * assemble one with an arm missing.
 */
export function reviewReading(
  rows: {
    prReviews: ReadonlyMap<number, PrReview>;
    prReviewRoutes: ReadonlyMap<number, PrReviewRoute>;
    prReviewedElsewhere: ReadonlySet<number>;
  },
  prNumber: number,
): PrReviewReading {
  return {
    review: rows.prReviews.get(prNumber) ?? null,
    route: rows.prReviewRoutes.get(prNumber) ?? null,
    elsewhere: rows.prReviewedElsewhere,
  };
}

export interface PrReviewCharters {
  /** How to choose a mode, for the triage. Null where the project names no file. */
  routing: string | null;
  /** What each mode looks for, keyed as `review.modes` is. */
  modes: Record<string, string | null>;
}
