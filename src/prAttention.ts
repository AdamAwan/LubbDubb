/**
 * Whose turn is it on this pull request? (issue #123, spun out of #109.)
 *
 * ## Why this is not `prHealth` with more reasons
 *
 * `prHealth` answers *can this merge* — and it is consumed by the merge gate's
 * phrasing and by `world_read`'s agent-facing output, so it has to keep answering
 * exactly that. Attention answers *who is this waiting on*, and the two have
 * different right answers for the same PR: a stacked PR with red inherited CI is
 * honestly `CI failing on base PR #7` to the first question and `waiting on PR #7`
 * to the second; a PR with three unresolved comments and an agent already on the
 * branch is `3 unresolved comments` to the first and `an agent is already on it`
 * to the second. Folding them would make one of the two answers a lie every time
 * they disagree, so this is a verdict *beside* `prHealth`, reading the same lists.
 *
 * ## Why `last_actor` is not the predicate
 *
 * The prior art (#109's `last_actor` note) derives "is this in your court" from
 * the participant who last acted. That works on a closed two-party board where
 * every state change has an actor. Ours is not closed: CI turning a PR red, a base
 * branch moving, a third-party review landing all arrive through `worldDiff` as
 * `WorldEvent`s with **no participant identity attached at all**, and they are the
 * most common reason a PR needs attention. What transfers from the prior art is
 * the *discipline* — many gates folded into one pure verdict with reasons, the way
 * `issuePickupStatus` already does on the issue side — not the signal.
 *
 * The one place participant identity genuinely exists is `PrComment.author`, and
 * it is deliberately **not** read here. An unhandled comment is what makes rule `pr-review-comment`
 * dispatch an agent, whoever wrote it, so the author changes nothing about whose
 * turn it is; branching on it would recreate the two-party assumption in the one
 * corner of the world that happens to carry a name. `handled` is what decides;
 * `author` appears only in the wording of a reason, never in a branch.
 *
 * ## Nothing in the dispatcher reads this
 *
 * It is a **lens**, like `findings` and `overlaps` and unlike the pending-proposal
 * gate. Every input it folds is already a gate that fires on its own — the branch
 * gate, `proposalHold`, `dispatchVerdict`, `isPrExcluded` — so a rule reading this
 * verdict would be taking a *second* opinion about a decision made somewhere else,
 * from a function sitting nowhere near the rule it duplicates. That is the drift
 * this repo has already paid for twice. A verdict the dispatcher acts on is a new
 * gate with its own failure modes; a verdict only the cockpit reads cannot change
 * what happens, only what an operator can see. `test/prAttention.test.ts` asserts
 * the property rather than trusting the import graph to keep it.
 */

import { ciNeedsHuman, classifyCiFailures, classifyWatchedChecks, type CiPolicy } from './ci/ciPolicy.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatcher/dispatchCooldown.js';
import { prCommentsOrigin } from './dispatcher/reviewThreads.js';
import { concernUrgency, type StageRuleId } from './dispatcher/rules.js';
import {
  basePrOf,
  ciNeedsAttention,
  inheritedCiFailure,
  isPrWatched,
  isStackedPr,
  needsBaseUpdate,
  prState,
} from './prHealth.js';
import { mergeProposalRef, proposalHold } from './proposals/proposals.js';
import { isActiveTask } from './tasks.js';
import type { Decision, Proposal, PullRequest, TaskSummary, ViewerAssignment, WorldEvent } from './types.js';

/**
 * Whose court the PR is in. Seven arms, and each names a *different party* rather
 * than a different flavour of stuck — that split is the whole verdict.
 */
type PrAttentionKind =
  | 'done' // merged or closed — off the board, nobody's turn
  | 'unwatched' // nobody opted it in: nobody's turn, by the absence of your tag
  | 'you' // your court — a verdict is owed, or an agent parked on you
  | 'harness' // the harness's court — staffed, or about to be
  | 'elsewhere' // outside the loop — a reviewer, a CI run, the PR below it
  | 'settled' // you answered; nothing is owed until the world moves
  | 'stalled'; // nobody's court, and *that* is the thing to look at

export interface PrAttention {
  status: PrAttentionKind;
  /** Human-readable, most actionable first. Never empty — every arm says why. */
  reasons: string[];
  /**
   * How long this pull request has been sitting on a reviewer (ISO instant it
   * started), on the two arms that mean it: `waiting on review`, and **any court
   * an assignment took over** — where the reviewer the clock is about is the
   * operator themselves. Absent everywhere else.
   *
   * **It does not, by itself, make the PR your court.** `waiting on review` stays
   * `elsewhere` on a pull request the operator merely opened, because on a team
   * the reviewer is somebody else and a queue of other people's obligations is
   * not an inbox — it is the thing that makes an inbox stop being read. There it
   * is an age on a row you were already looking at and nothing more: no needs-you
   * entry, no human task, no escalation. What changes on an assignment is only
   * *whose* wait it is; the clock, and every rule about when it runs, is the same
   * one. → `docs/spec/07-pull-requests.md#how-long-it-has-been-waiting-on-a-reviewer`
   */
  reviewWaitingSince?: string;
  /**
   * Set when this pull request is your court **because a person put it on you** —
   * the arm that decided was the assignment and not a proposal, an escalation or a
   * spent attempt cap.
   *
   * Carried as its own field rather than left to be read off the leading reason,
   * because the queue keys on it (`buildNeedsYou`) and a surface that matched the
   * sentence would file every future rewording of it as "not assigned". It is
   * absent on a PR that is assigned to you *and* has an agent on it: the
   * assignment is then a reason, not the answer, and a row for it would ask the
   * operator to do something the harness is already doing.
   */
  assignedToYou?: ViewerAssignment;
}

/** Everything the contextual arms need. Pure over this plus the PR. */
export interface PrAttentionContext {
  /**
   * Every open PR the world knows about, **unfiltered** — the dispatch world plus
   * `ctx.unwatchedPrs`. The same list `inheritedCiFailure`/`basePrOf` take, and for
   * the same reason: an unwatched base still attributes, so a stacked PR waiting on
   * an unwatched parent says so instead of reading as stalled.
   */
  openPrs: PullRequest[];
  /** The integration branch, for {@link isStackedPr}. */
  defaultBranch: string;
  /** The `${labelPrefix}-watch` tag. Empty = the gate is off, everything is watched. */
  watchLabel: string;
  /** Live and finished tasks; the branch's active one is what staffs a PR. */
  tasks: TaskSummary[];
  /** Acts put to a human, newest-first — the store's order, which `proposalHold` assumes. */
  proposals: Proposal[];
  /**
   * World transitions since the oldest standing rejection (`rejectionSignalQuery`
   * → `Store.listWorldEventsSince`). Absent = nothing observed, so every rejection
   * still stands — the same fail-closed direction `proposalHold` takes.
   */
  rejectionSignals?: WorldEvent[];
  /** The recent audit window, for the attempt cap. */
  recentDecisions: Decision[];
  cooldown: CooldownPolicy;
  /**
   * The per-check CI policy — the same `config.ci` the dispatcher holds, so this
   * verdict names the court rule `pr-ci-failing` will actually act in. Threaded as policy rather
   * than as a pre-computed verdict so nothing depends on the snapshot having
   * classified the PR first; `classifyCiFailures` is pure, so asking twice is one
   * answer, not two.
   */
  ci: CiPolicy;
  /** "Now" — the world snapshot's `takenAt`, as everywhere else. */
  now: string;
  /**
   * PR number → when it started waiting on a reviewer (`Store.reviewWaits`).
   * Absent means the reading is unavailable, which costs an age and never a
   * verdict — every arm answers the same with or without it.
   */
  reviewWaits?: ReadonlyMap<number, string>;
}

/**
 * Fold every gate that decides what happens to a PR into one per-PR verdict about
 * *whose turn it is*. Checked in the order the world resolves them, so the first
 * arm that matches is the honest answer and the ones below it are moot.
 */
export function prAttentionStatus(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  const verdict = court(pr, ctx);
  const assigned = pr.viewerAssignment;
  if (assigned === undefined || verdict.status === 'done') return verdict;
  const note = assignmentReason(pr, assigned);
  // You have answered. A review request is a question, and a question you have
  // already given a verdict on is not still yours — so the assignment drops from
  // *the court* to *a reason*, exactly as it does on a pull request an agent is
  // already working. The clause survives so the row still says how it came to be
  // yours; `assignedToYou` stays unset, which is what takes it off the rail.
  // Absent (a provider that does not resolve a vote) is never read as a verdict.
  if (pr.viewerApproved === true) {
    return { ...verdict, reasons: [...verdict.reasons, `${note} — you have approved it`] };
  }
  // The three arms where **nothing in the harness is coming**: no rule will fire,
  // no proposal is waiting and no agent is on it. There the assignment is not
  // colour on somebody else's verdict — it is the whole answer to whose turn it
  // is, and it leads. `waiting on review` in particular is a lie about a pull
  // request you were handed: the reviewer it names is you.
  if (verdict.status === 'unwatched' || verdict.status === 'elsewhere' || verdict.status === 'stalled') {
    // And how long it has been waiting — on *them*, now that the reviewer the
    // clock is about is the operator. The `waiting on review` arm sets this
    // itself; the other two never reach it, so an assigned pull request nobody
    // tagged carried no age at all, which is the case the rail shows most. The
    // watermark is the same reading either way (`awaitingReview`, folded once per
    // pulse): the instant this pull request became reviewable with nobody having
    // reviewed it. Absent — red CI, an unhandled comment, a staffed branch, or a
    // harness that has not observed a pulse of it yet — draws no age, because a
    // reviewer cannot be late for work that is not ready.
    const since = verdict.reviewWaitingSince ?? ctx.reviewWaits?.get(pr.number);
    return {
      ...verdict,
      status: 'you',
      reasons: [note, ...verdict.reasons],
      assignedToYou: assigned,
      ...(since === undefined ? {} : { reviewWaitingSince: since }),
    };
  }
  // Every other arm already has a court, and it is the right one: a PR with an
  // agent on its branch is the harness's whoever it is assigned to. The
  // assignment rides along as the last reason so the row still says it, and
  // `assignedToYou` stays unset so the queue does not raise a row for work
  // somebody is already doing.
  return { ...verdict, reasons: [...verdict.reasons, note] };
}

/**
 * How an assignment reads on the row — one clause naming **the person who asked**,
 * because that is the whole of what makes it an obligation rather than a form
 * field. The old wording ("you are an optional reviewer") described the operator's
 * row in a list somewhere; this one describes something a colleague did.
 *
 * **Which kind of reviewer is not in the sentence.** It is `assignedToYou`, a
 * field, and a surface that wants to say it reads that — the same reason the queue
 * keys on the field rather than matching the wording. Saying it twice would put
 * the distinction in a string that any rewording can silently drop.
 *
 * An author the provider did not report drops out of the sentence rather than
 * being invented: every arm below still reads without a name.
 */
function assignmentReason(pr: PullRequest, assignment: ViewerAssignment): string {
  const who = pr.author?.trim() ?? '';
  if (assignment === 'assignee') return who === '' ? 'assigned to you' : `${who} assigned this pull request to you`;
  return who === '' ? 'you have been marked as a reviewer' : `${who} marked you as a reviewer`;
}

/**
 * The court, before the assignment is folded in — every arm below is about a rule,
 * a proposal or an agent, and none of them knows anything about who the pull
 * request was handed to. Split out so {@link prAttentionStatus} can say where an
 * assignment *overrides* a court and where it is only a reason, in one place
 * rather than in eight arms.
 */
function court(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  // A PR that left the open set is off the board. Read through `prState`, which
  // never invents `closed` — an abandoned PR has to have been observed as one.
  const state = prState(pr);
  if (state !== 'open') {
    return { status: 'done', reasons: [state === 'merged' ? 'merged' : 'closed without merging'] };
  }

  // Being unwatched is a *status*, not an absence: the cockpit still lists an
  // unwatched PR with its health, so a verdict that skipped it would leave the one
  // row whose emptiness means something looking exactly like the rows whose
  // emptiness means nothing. It comes first because `Harness.runCycle` filters
  // these out of the dispatch world entirely — every arm below would be describing
  // rules that cannot fire.
  if (!isPrWatched(pr, ctx.watchLabel)) {
    return { status: 'unwatched', reasons: [`not tagged "${ctx.watchLabel}" — the harness is leaving it alone`] };
  }

  // A pending proposal is the one unambiguous "your court", and this verdict
  // **names it** rather than deferring to the inbox. "Needs you" counts open
  // escalations across the whole world; the PR row not saying why it is stalled is
  // precisely the re-derivation across four panels this exists to remove. The cost
  // is one PR appearing in two places — paid deliberately, and made joinable by
  // quoting the proposal id, which is what keeps the two surfaces one fact.
  const pending = ctx.proposals.find((p) => p.status === 'pending' && p.ref.startsWith(`pr:${pr.number}:`));
  if (pending) {
    return { status: 'you', reasons: [`awaiting your accept/reject of ${actLabel(pending)} (${pending.id})`] };
  }

  // The branch's agent. A *waiting* one is parked on a human — that is your court,
  // not the harness's, and it is the difference between this verdict and
  // `issuePickupStatus`, which folds all three task states into one `active` arm
  // because pickup only asks whether the origin is staffed.
  const staffed = ctx.tasks.find((t) => isActiveTask(t) && t.branch === pr.branch);
  if (staffed?.status === 'waiting') {
    return { status: 'you', reasons: ['an agent on this branch is waiting on you'] };
  }
  if (staffed) {
    return {
      status: 'harness',
      reasons: [
        staffed.status === 'running' ? 'an agent is working this branch' : 'an agent is queued for this branch',
      ],
    };
  }

  // What the CI policy makes of the failing checks — asked once, here, and threaded
  // into both the concern list and the tail, because rule `pr-ci-failing` dispatches only when
  // the verdict is `actionable` (`ruleDispatcher.ts`) and this verdict has to name
  // the same court the rules will actually act in.
  const ci = ciReading(pr, ctx);

  // The concerns rules `pr-review-comment`/`pr-ci-failing`/`pr-base-update` build,
  // in their urgency order (comments > CI > gate > base > conflict) and off their own
  // predicates. Re-derived here rather than shared with the
  // dispatcher because the rules build prompt-bearing concerns and this needs only
  // the labels and the top origin — the same relationship `issuePickupStatus` has
  // to rule `issue-pickup`, and the same drift risk, which is why 07-pull-requests.md states
  // the order once for both.
  const concerns = prConcerns(pr, ctx, ci);
  // A failure the policy holds, carried as a *reason* rather than as an arm of its
  // own when there is a concern under it. `heldByPolicy` says nothing to dispatch
  // **for the CI failure** — rule `pr-ci-blocked` has filed the escalation — and
  // says nothing at all about the PR's other concerns, which rules
  // `pr-review-comment` and `pr-base-update` staff from the same loop iteration
  // that raised it. Answered above the fold, it printed "no agent will be sent" on
  // the pulse an agent went out (#564), which is the mirror image of the promise
  // the arm was added to stop.
  const heldNames = ci.heldByPolicy.join(', ');
  const held = ci.heldByPolicy.length > 0 ? [`${heldNames} failing — held by the CI policy`] : [];
  if (concerns.length > 0) {
    const top = concerns[0]!;
    const others = [...concerns.slice(1).map((c) => c.label), ...held];
    const verdict = dispatchVerdict(top.origin, ctx.now, ctx.recentDecisions, ctx.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') {
      // The attempt cap is the one way a concern stops being the harness's problem
      // without being fixed: rule `cooldown-escalate` hands it to a human.
      return { status: 'you', reasons: [`${top.label} — the attempt cap is spent, escalated to a human`, ...others] };
    }
    if (verdict.kind === 'cooldown') {
      return { status: 'harness', reasons: [`${top.label} — on cooldown, retrying`, ...others] };
    }
    return { status: 'harness', reasons: [`${top.label} — an agent will be dispatched`, ...others] };
  }

  // Nothing else outstanding, so the held check is the whole story and the
  // unqualified sentence is true again: this is one of the two ways a failing
  // check stops being the harness's problem without being fixed, the other being
  // the spent attempt cap above.
  if (ci.heldByPolicy.length > 0) {
    return {
      status: 'you',
      reasons: [`${heldNames} failing — the CI policy holds it, so no agent will be sent`],
    };
  }

  // Merge-readiness, exactly as rule `pr-merge-ready` tests it. Reproduced rather than imported
  // for the same reason as the concerns above; 05-dispatcher.md states the list.
  const mergeReady =
    !isStackedPr(pr, ctx.defaultBranch) &&
    pr.ciStatus === 'passing' &&
    pr.approved === true &&
    pr.mergeable === true &&
    pr.mergeableState !== 'behind' &&
    pr.mergeableState !== 'blocked' &&
    pr.mergeableState !== 'dirty' &&
    pr.unresolvedComments.every((c) => c.handled);

  if (mergeReady) {
    // Ask the gate, not the row: `proposalHold` is where a rejection stops standing
    // once the world moves (#122), and asking it here is what keeps this verdict
    // from claiming "settled" about a PR rule `pr-merge-ready` is about to re-propose. The pending
    // arm is answered above, so what is left is a rejection or a settling accept.
    const ref = mergeProposalRef(pr.number);
    const held = proposalHold('merge', ref, ctx.proposals, {
      rejectionSignals: ctx.rejectionSignals,
      now: Date.parse(ctx.now),
    });
    const standing = ctx.proposals.find((p) => p.kind === 'merge' && p.ref === ref);
    if (held && standing?.status === 'rejected') {
      // Nobody's turn, by design: you answered and the harness is correctly quiet.
      // Invisible until now, which is the same invisibility `capped` and
      // `unapproved` were added to `QueueItem` to fix. The hold string already
      // quotes the note, so the operator sees *what they said* and not just that
      // they said something.
      return { status: 'settled', reasons: [held, 'nothing has happened to this PR since'] };
    }
    if (held) return { status: 'harness', reasons: [held] };
    return { status: 'harness', reasons: ['merge-ready — the merge gate runs next cycle'] };
  }

  // Nothing is owed to you and nothing is the harness's to do. Either something
  // outside the loop is holding it, or nothing is — and those two must not read
  // the same, which is the whole reason `stalled` is an arm.
  if (isStackedPr(pr, ctx.defaultBranch)) {
    const base = basePrOf(pr, ctx.openPrs);
    const inherited = inheritedCiFailure(pr, ctx.openPrs);
    if (inherited) return { status: 'elsewhere', reasons: [`CI failing on base PR #${inherited.number}`] };
    return {
      status: 'elsewhere',
      reasons: [base ? `stacked on PR #${base.number}, which has to merge first` : `stacked on ${pr.baseBranch}`],
    };
  }
  if (pr.ciStatus === 'pending') return { status: 'elsewhere', reasons: ['CI is still running'] };
  if (pr.approved !== true) {
    const since = ctx.reviewWaits?.get(pr.number);
    return { status: 'elsewhere', reasons: ['waiting on review'], ...(since ? { reviewWaitingSince: since } : {}) };
  }
  if (pr.mergeableState === 'blocked') {
    return { status: 'elsewhere', reasons: ['merge blocked (required checks/reviews)'] };
  }

  // Green, approved, unstaffed, unproposed and still not mergeable by rule `pr-merge-ready`'s
  // reading — so no rule will ever act on it and no human has been asked to. Name
  // what is missing: this arm exists to be looked at, not to be a fallback.
  const missing: string[] = [];
  if (ci.mutedOnly) {
    // Red, and every failing check is one the operator told the harness to leave
    // alone — so rule `pr-ci-failing` will not dispatch and rule `pr-ci-blocked` will not escalate, and yet
    // rule `pr-merge-ready`'s merge test reads the *aggregate* `ciStatus`, which is still failing.
    // Nothing will ever move this PR. "CI has not reported" would be a lie about a
    // check that reported and was muted, and it is the one wording that hides the
    // gap rather than naming it.
    missing.push(`${ci.muted.join(', ')} failing but muted by policy — the merge gate still reads CI as failing`);
  } else if (pr.ciStatus !== 'passing') missing.push('CI has not reported');
  if (pr.mergeable !== true) missing.push('the provider reports no mergeable state');
  return {
    status: 'stalled',
    reasons: missing.length > 0 ? missing : ['no agent, no signal and nothing to authorize'],
  };
}

/** One thing about a PR that would, on its own, warrant a code agent. */
interface PrConcern {
  /**
   * The pipeline rule that would raise this concern — what {@link concernUrgency}
   * ranks it by, so the order is read off `DISPATCH_PIPELINE` rather than encoded
   * in the order the pushes happen to appear in below (#562).
   */
  rule: StageRuleId;
  /**
   * The dispatch origin rules `pr-ci-failing`/`pr-base-update`/`pr-review-comment`
   * use — what the cooldown is keyed on. It has to be a ref the dispatcher
   * actually writes decisions under: a lens reading a key nothing dispatches finds
   * zero attempts forever and answers `dispatch` forever (#563).
   */
  origin: string;
  label: string;
}

/**
 * What the per-check CI policy makes of this PR — the reading rule `pr-ci-failing` makes before
 * it dispatches, made once here and used by three arms.
 *
 * It exists because `ciStatus` is a fold and this verdict is about *courts*: a red
 * check the policy dispatches for is the harness's, a red check it escalates is
 * yours, and a red check it mutes is nobody's while still holding rule `pr-merge-ready`'s merge
 * test shut. Reading only the aggregate collapsed all three into "an agent will be
 * dispatched", which is a promise the dispatcher does not keep for two of them.
 *
 * An **inherited** failure reads as no failure at all, exactly as `prConcerns` and
 * rule `pr-ci-failing` both already treat it: the fix belongs to the PR underneath, and the
 * `elsewhere` arm names it. Checking that here rather than per-arm is what keeps a
 * stacked PR from being handed to you for its parent's red build.
 */
interface CiReading {
  /** Failing checks the policy hands to a human — rule `pr-ci-blocked`'s set. */
  heldByPolicy: string[];
  /** Failing checks the operator muted, when *every* failure is one. */
  muted: string[];
  /** True when the whole failure is muted, so nothing will act and nothing is owed. */
  mutedOnly: boolean;
  /** Whether rule `pr-ci-failing` would dispatch — the gate the CI concern now rides on. */
  actionable: boolean;
  /**
   * Checks a `ci.checks` rule watches in a non-failing state and would dispatch
   * for — rule `pr-ci-gate`'s set. Read whether or not anything is failing: a
   * waiting gate is the case where the PR is *not* red and an agent is coming
   * anyway, which is precisely the reading the `elsewhere` tail used to get wrong
   * ("CI is still running", forever).
   */
  watched: string[];
}

function ciReading(pr: PullRequest, ctx: PrAttentionContext): CiReading {
  const none: CiReading = { heldByPolicy: [], muted: [], mutedOnly: false, actionable: false, watched: [] };
  // An inherited failure is nobody's business here for the reason rule
  // `pr-ci-failing` and rule `pr-ci-gate` both skip it: the fix belongs to the PR
  // underneath, and the `elsewhere` arm names it.
  if (inheritedCiFailure(pr, ctx.openPrs) !== null) return none;
  const watched = classifyWatchedChecks(pr.ciChecks, ctx.ci).watched.map((m) => m.name);
  // The same gate rule `pr-ci-failing` rides, read from the same predicate: the lens telling an
  // operator a PR is nobody's turn while an agent is being dispatched for it is
  // the drift this whole file exists to avoid.
  if (!ciNeedsAttention(pr)) return { ...none, watched };
  const verdict = classifyCiFailures(pr.ciChecks, ctx.ci, pr.ciChecksWithheld);
  if (verdict.actionable) return { ...none, watched, actionable: true };
  const muted = verdict.ignored.map((m) => m.name);
  return {
    heldByPolicy: ciNeedsHuman(verdict) ? verdict.escalate.map((m) => m.name) : [],
    muted,
    watched,
    // `actionable` is false and nothing escalates, so every failure the provider
    // reported is muted. Guarded on the list being non-empty: a provider reporting
    // no per-check detail yields `actionable: true` and never reaches here, but a
    // policy could in principle classify a failure into no bucket at all.
    mutedOnly: !ciNeedsHuman(verdict) && muted.length > 0,
    actionable: false,
  };
}

/**
 * The concerns the five PR-concern rules (`pr-review-comment` through
 * `pr-base-update-conflict`) would raise for this PR, most urgent first. Same predicates, same origins and
 * the same order as the dispatcher — the order asked for rather than restated
 * (see {@link concernUrgency}); the labels are the operator-facing half only, so
 * nothing here can drift into deciding what an agent is *told*.
 */
function prConcerns(pr: PullRequest, ctx: PrAttentionContext, ci: CiReading): PrConcern[] {
  const concerns: PrConcern[] = [];
  // **One** concern for the whole review, on the origin rule `pr-review-comment`
  // dispatches under — never one per thread. The per-thread ref is what notify
  // de-dup keys on and nothing dispatches it (`reviewThreads.ts`), so a lens
  // reading it asked the ledger about a key with no history and told the operator
  // an agent was coming on a review whose attempt cap a human already holds.
  // `prCommentsOrigin` is imported rather than re-typed for exactly that reason.
  const unhandled = pr.unresolvedComments.filter((c) => !c.handled);
  if (unhandled.length > 0) {
    const authors = [...new Set(unhandled.map((c) => c.author))];
    concerns.push({
      rule: 'pr-review-comment',
      origin: prCommentsOrigin(pr.number),
      label:
        unhandled.length > 1
          ? `${unhandled.length} unresolved comments from ${authors.join(', ')}`
          : `unresolved comment from ${authors[0]}`,
    });
  }
  // Gated on the policy verdict, not on `ciStatus` alone: rule `pr-ci-failing` dispatches only
  // when the classification is actionable, so raising the concern off the aggregate
  // promised an agent for a check the policy had already taken off the table. An
  // inherited failure is excluded inside `ciReading` for the reason rule `pr-ci-failing` excludes
  // it — the fix belongs to the PR underneath, and the `elsewhere` arm says so.
  if (ci.actionable) {
    concerns.push({ rule: 'pr-ci-failing', origin: `pr:${pr.number}:ci`, label: 'CI is failing' });
  }
  // Rule `pr-ci-gate`'s concern. Its own origin, because the rule's cooldown is
  // keyed on one — a lens quoting the CI origin here would report the wrong
  // attempt cap.
  if (ci.watched.length > 0) {
    concerns.push({
      rule: 'pr-ci-gate',
      origin: `pr:${pr.number}:ci-gate`,
      label: `${ci.watched.join(', ')} waiting on an action`,
    });
  }
  if (needsBaseUpdate(pr)) {
    const base = pr.baseBranch ?? ctx.defaultBranch;
    // Split on the same boolean the rule splits its id on, so the lens names the
    // rule the dispatch will actually record — the two are separately priced in
    // `agentModels.byRule`, and a row explaining itself by the wrong one would
    // quote the wrong profile. The origin is shared, exactly as the rule shares it.
    const behind = pr.mergeableState === 'behind';
    concerns.push({
      rule: behind ? 'pr-base-update' : 'pr-base-update-conflict',
      origin: `pr:${pr.number}:mergeable`,
      label: behind ? `behind ${base}` : `conflicts with ${base}`,
    });
  }
  // The order is the pipeline's, asked for rather than reproduced. Statement order
  // is what drifted the last time the pipeline was reordered, and it drifts
  // silently: both lists still read plausibly, and only a run of the dispatcher
  // beside the lens shows they disagree.
  return concerns.sort((a, b) => concernUrgency(a.rule) - concernUrgency(b.rule));
}

/** How a proposed act reads inside "awaiting your accept/reject of …". */
function actLabel(proposal: Proposal): string {
  if (proposal.kind === 'merge') return 'the merge';
  if (proposal.kind === 'plan') return 'the plan';
  return 'the drafted reply';
}
