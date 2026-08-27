import type { PrReview, PrReviewRoute, PullRequest } from '../types.js';
import type { PrReviewPolicy } from './policy.js';

/**
 * The fleet's own read of a pull request, before a person is asked for theirs.
 *
 * Pure over the world, the policy and the recorded rows — the two rules
 * (`src/dispatcher/rules/`), the lens (`src/prAttention.ts`) and the merge gate
 * all ask *these* functions rather than each restating the predicate, which is
 * the arrangement the concern order already has and for the same reason: two
 * readings of one question drift silently, and the only symptom is a row that
 * explains a dispatch that did not happen.
 * → `docs/spec/07-pull-requests.md#the-fleet-review`
 */

/**
 * The review's dispatch origin. Its own, not `pr:<n>:ci` or the comment origin,
 * so the review carries its own cooldown and its own attempt budget: a review
 * that cannot be got through must not spend the budget a red build needs, and an
 * escalation raised at the cap has to name which of the two it was about.
 */
export function reviewOrigin(prNumber: number): string {
  return `pr:${prNumber}:review`;
}

/**
 * Triage's origin, separate from the review's for the reason `pr-ci-gate` is
 * separate from `pr-ci-ci`: they are two problems, and one budget across both
 * would let a routing that cannot be got through cap the review that was never
 * attempted — and would leave the failure naming whichever of the two the log
 * happened to quote.
 */
export function reviewTriageOrigin(prNumber: number): string {
  return `pr:${prNumber}:review-triage`;
}

/**
 * The read-only checkout the reviewer is given: a detached checkout *of* the pull
 * request's branch, never the branch itself.
 *
 * A reviewer that holds the branch lease is a reviewer that blocks the CI fix
 * behind it, and one that can commit is one that fixes what it found and then
 * reviews its own fix. `readOnlyDispatch` gives it a name and no ref of its own.
 */
export function reviewBranch(prNumber: number): string {
  return `review/pr-${prNumber}`;
}

/**
 * The pull request a `review_report` or `review_route` call is about, read from
 * the caller's own dispatch origin and never from an argument — the tool
 * channel's one structural guarantee ([11](docs/spec/11-mcp-tools.md)). Null for
 * any other origin, which is how an agent that was not dispatched for this
 * refuses rather than writing about a pull request it was never sent at.
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
 * Is there a routing decision to make at all?
 *
 * **One mode is not a choice**, so the triage is switched on by there being two,
 * rather than by a flag of its own — a flag could disagree with the modes, and
 * one of the two would then be ignored with nothing to say which.
 */
export function routesBetweenModes(policy: PrReviewPolicy): boolean {
  return reviewModeNames(policy).length > 1;
}

/**
 * The mode a review runs in when nothing chose one.
 *
 * This is the fail-open target, and everything about it points the same way: a
 * triage that crashed, was killed or spent its cap must cost a more careful read
 * than the pull request needed, never a pull request nobody reads. Null policy
 * default takes the first declared mode, which is why the spec tells a project to
 * declare its thorough mode first.
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
  // A route naming a mode the project has since removed is not honoured: the
  // charter and the profile behind that name are gone, so the honest answer is
  // the same one a triage failure gets.
  if (route !== null && names.includes(route.mode)) return route.mode;
  return defaultReviewMode(policy);
}

/**
 * Does this pull request still want the fleet's review?
 *
 * **One round, and the round is the row.** There is no re-review on a push: a
 * verdict recorded is a pull request reviewed, for the life of the pull request.
 * That is why the row is keyed on the pull request rather than on the head SHA it
 * was taken against — a key that moved with the diff would be invalidated by the
 * very first fix pushed after the review, and with nothing re-reviewing, the
 * merge gate below would then never be satisfied again. The PR would sit
 * unmergeable forever with nothing red, which is the silence this shape exists to
 * avoid. The SHA is still recorded, because *what was read* is worth saying; it
 * simply decides nothing.
 *
 * **A pull request with unhandled human review threads is skipped**, and skipped
 * rather than ordered below them: a reviewer already asked for changes, so the
 * diff is about to be rewritten and a second opinion on the old one is spent for
 * nothing. It comes back on the next pulse after the threads are handled — the
 * work is not lost, only deferred to a diff that is going to survive.
 */
export function needsFleetReview(pr: PullRequest, review: PrReview | null, policy: PrReviewPolicy): boolean {
  if (!policy.enabled) return false;
  if (pr.merged || review !== null) return false;
  return pr.unresolvedComments.every((c) => c.handled);
}

/**
 * Whether the merge gate is satisfied — asked by rule `pr-merge-ready` and by the
 * lens that explains it.
 *
 * **It asks whether the review happened, not whether it liked what it saw.** With
 * one round there is nothing that could clear a `findings` verdict, so gating on
 * `clear` would wedge every pull request the reviewer had an opinion about, and
 * the operator's only exit would be to turn the feature off. What findings do
 * instead is reach the person who approves — on the row, and on the pull request
 * itself where `publish` is on — before they give the approval rule
 * `pr-merge-ready` already requires. The gate's job is to stop a merge nobody
 * looked at; the judgement stays a human's, exactly as it was.
 *
 * Unknown is never clear: a pull request with no row is held.
 */
export function reviewSatisfied(review: PrReview | null, policy: PrReviewPolicy): boolean {
  if (!policy.enabled || !policy.blocking) return true;
  return review !== null;
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
 * What the reviewer is told to do with what it found, appended rather than
 * interpolated for the reason every addition to a prompt is.
 *
 * The wording names `reply_to_review` rather than leaving the channel open,
 * because the habit it is displacing — an agent posting from its own shell with
 * the operator's credential — is older than the tool and is what an unqualified
 * "post your findings" gets. Off, the reviewer is told explicitly that nobody is
 * waiting on a comment, so a helpful agent does not go and write one anyway.
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
 * The project's own words, appended verbatim under a heading that says whose they
 * are — a mode's charter for the reviewer, the routing charter for the triage.
 *
 * Attributed rather than folded into the prompt's voice: an agent that cannot
 * tell the harness's instructions from its team's cannot weigh them against what
 * it is actually reading, and a charter that contradicts the repository is itself
 * worth reporting.
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
 * The charters as the dispatcher holds them: text, never paths.
 *
 * Nothing in a rule reads the filesystem, exactly as `validationRoot` is only
 * ever phrased — so the files are read once at boot (`src/review/charter.ts`) and
 * what reaches a stage is what they said.
 */
export interface PrReviewCharters {
  /** How to choose a mode, for the triage. Null where the project names no file. */
  routing: string | null;
  /** What each mode looks for, keyed as `review.modes` is. */
  modes: Record<string, string | null>;
}
