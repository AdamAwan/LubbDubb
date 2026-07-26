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
 * it is deliberately **not** read here. An unhandled comment is what makes rule 2b
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

import { dispatchVerdict, type CooldownPolicy } from './dispatcher/dispatchCooldown.js';
import { basePrOf, inheritedCiFailure, isPrExcluded, isStackedPr, needsBaseUpdate, prState } from './prHealth.js';
import { mergeProposalRef, proposalHold } from './proposals/proposals.js';
import type { Decision, Proposal, PullRequest, Task, WorldEvent } from './types.js';

/**
 * Whose court the PR is in. Seven arms, and each names a *different party* rather
 * than a different flavour of stuck — that split is the whole verdict.
 */
export type PrAttentionKind =
  | 'done' // merged or closed — off the board, nobody's turn
  | 'ignored' // you tagged it: nobody's turn, by your instruction
  | 'you' // your court — a verdict is owed, or an agent parked on you
  | 'harness' // the harness's court — staffed, or about to be
  | 'elsewhere' // outside the loop — a reviewer, a CI run, the PR below it
  | 'settled' // you answered; nothing is owed until the world moves
  | 'stalled'; // nobody's court, and *that* is the thing to look at

export interface PrAttention {
  status: PrAttentionKind;
  /** Human-readable, most actionable first. Never empty — every arm says why. */
  reasons: string[];
}

/** Everything the contextual arms need. Pure over this plus the PR. */
export interface PrAttentionContext {
  /**
   * Every open PR the world knows about, **unfiltered** — the dispatch world plus
   * `ctx.excludedPrs`. The same list `inheritedCiFailure`/`basePrOf` take, and for
   * the same reason: an `-ignore`d base still attributes, so a stacked PR waiting
   * on an ignored parent says so instead of reading as stalled.
   */
  openPrs: PullRequest[];
  /** The integration branch, for {@link isStackedPr}. */
  defaultBranch: string;
  /** The `${labelPrefix}-ignore` tag. Empty = the gate is off, nothing is ignored. */
  ignoreLabel: string;
  /** Live and finished tasks; the branch's active one is what staffs a PR. */
  tasks: Task[];
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
  /** "Now" — the world snapshot's `takenAt`, as everywhere else. */
  now: string;
}

/**
 * Fold every gate that decides what happens to a PR into one per-PR verdict about
 * *whose turn it is*. Checked in the order the world resolves them, so the first
 * arm that matches is the honest answer and the ones below it are moot.
 */
export function prAttentionStatus(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  // A PR that left the open set is off the board. Read through `prState`, which
  // never invents `closed` — an abandoned PR has to have been observed as one.
  const state = prState(pr);
  if (state !== 'open') {
    return { status: 'done', reasons: [state === 'merged' ? 'merged' : 'closed without merging'] };
  }

  // The ignore tag is a *status*, not an absence: the cockpit still lists an
  // excluded PR with its health, so a verdict that skipped it would leave the one
  // row whose emptiness means something looking exactly like the rows whose
  // emptiness means nothing. It comes first because `Harness.runCycle` filters
  // these out of the dispatch world entirely — every arm below would be describing
  // rules that cannot fire.
  if (isPrExcluded(pr, ctx.ignoreLabel)) {
    return { status: 'ignored', reasons: [`tagged "${ctx.ignoreLabel}" — the harness is leaving it alone`] };
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

  // The concerns rules 1/2/2b build, in their urgency order (CI > base > comment)
  // and off their own predicates. Re-derived here rather than shared with the
  // dispatcher because the rules build prompt-bearing concerns and this needs only
  // the labels and the top origin — the same relationship `issuePickupStatus` has
  // to rule 4, and the same drift risk, which is why 07-pull-requests.md states
  // the order once for both.
  const concerns = prConcerns(pr, ctx);
  if (concerns.length > 0) {
    const top = concerns[0]!;
    const others = concerns.slice(1).map((c) => c.label);
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

  // Merge-readiness, exactly as rule 3 tests it. Reproduced rather than imported
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
    // from claiming "settled" about a PR rule 3 is about to re-propose. The pending
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
  if (pr.approved !== true) return { status: 'elsewhere', reasons: ['waiting on review'] };
  if (pr.mergeableState === 'blocked') {
    return { status: 'elsewhere', reasons: ['merge blocked (required checks/reviews)'] };
  }

  // Green, approved, unstaffed, unproposed and still not mergeable by rule 3's
  // reading — so no rule will ever act on it and no human has been asked to. Name
  // what is missing: this arm exists to be looked at, not to be a fallback.
  const missing: string[] = [];
  if (pr.ciStatus !== 'passing') missing.push('CI has not reported');
  if (pr.mergeable !== true) missing.push('the provider reports no mergeable state');
  return {
    status: 'stalled',
    reasons: missing.length > 0 ? missing : ['no agent, no signal and nothing to authorize'],
  };
}

/** One thing about a PR that would, on its own, warrant a code agent. */
interface PrConcern {
  /** The dispatch origin rules 1/2/2b use — what the cooldown is keyed on. */
  origin: string;
  label: string;
}

/**
 * The concerns rules 1/2/2b would raise for this PR, most urgent first. Same
 * predicates and same order as the dispatcher; the labels are the operator-facing
 * half only, so nothing here can drift into deciding what an agent is *told*.
 */
function prConcerns(pr: PullRequest, ctx: PrAttentionContext): PrConcern[] {
  const concerns: PrConcern[] = [];
  // An inherited failure is suppressed here for the same reason rule 1 suppresses
  // it: the fix belongs to the PR underneath, and the `elsewhere` arm below says so.
  if (pr.ciStatus === 'failing' && inheritedCiFailure(pr, ctx.openPrs) === null) {
    concerns.push({ origin: `pr:${pr.number}:ci`, label: 'CI is failing' });
  }
  if (needsBaseUpdate(pr)) {
    const base = pr.baseBranch ?? ctx.defaultBranch;
    concerns.push({
      origin: `pr:${pr.number}:mergeable`,
      label: pr.mergeableState === 'behind' ? `behind ${base}` : `conflicts with ${base}`,
    });
  }
  for (const comment of pr.unresolvedComments) {
    if (comment.handled) continue;
    concerns.push({
      origin: `pr:${pr.number}:comment:${comment.id}`,
      label: `unresolved comment from ${comment.author}`,
    });
  }
  return concerns;
}

/** How a proposed act reads inside "awaiting your accept/reject of …". */
function actLabel(proposal: Proposal): string {
  if (proposal.kind === 'merge') return 'the merge';
  if (proposal.kind === 'plan') return 'the plan';
  return 'the drafted reply';
}

function isActiveTask(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}
