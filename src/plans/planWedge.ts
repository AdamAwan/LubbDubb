import type { Issue, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { liveParts, partBranch } from './parts.js';

/**
 * A plan that cannot proceed, and what the harness says about it.
 *
 * ## The gap this closes
 *
 * The ref-collision guard is correct and complete: `refs/heads/issue/12` blocks
 * every `refs/heads/issue/12/<slug>`, so the reconciler parks the parts `blocked`
 * and says so. What it does not do is *reach anyone*. The Errors panel is a feed,
 * and a feed carries news; the plan's own status comment reports progress, and a
 * plan with no progress reports none. So an issue picked up unplanned first, then
 * planned and approved onto its own taken branch, had red assemblers, no agent, no
 * question in "Needs you", and no route out.
 *
 * Two separate things were missing and they are kept separate here: a way to
 * *notice* ({@link planIsWedged}) and a way to *warn before it happens*
 * ({@link planApprovalWarnings}). The way out is Replan, on the plan sheet, which
 * is the way out of every plan that is wrong for any other reason too.
 *
 * ## What is deliberately not here
 *
 * **Nothing attaches the existing pull request to a part.** A PR on the flat
 * `issue/<n>` branch claims to resolve the whole issue, and nothing in the harness
 * knows which part, if any, it satisfies. Deriving that would be inferring a
 * positive terminal from incidental evidence, refused at every other point in this
 * codebase (`undeclared` vs `more_work`, the DONE sentinel vs the `result` event,
 * `conclude_part` refusing `kind: 'code'`). The PR is *named* to the operator and
 * left alone.
 */

/**
 * Is every live part of this plan blocked **by the ref collision**?
 *
 * The plan is then doing nothing and will go on doing nothing until someone acts,
 * and the someone is not the person who last touched it: a collision is a branch
 * that will not disappear on its own.
 *
 * **It reads `blockedBy`, not `status`**, and that is the whole of the predicate.
 * A declined human step blocks a part too, and a plan cut entirely into human
 * steps — a console-only change, or one whose code parts have merged — is then
 * every-live-part-blocked on the first decline. Read off the status, this answered
 * true and rule `plan-blocked` escalated the operator's own refusal back to them,
 * as a card about a git branch a plan with no branches does not have, offering a
 * control ("clear what is blocking the parts") that does not exist for it. Nothing
 * errored: an escalation is the harness working.
 *
 * A row the reconciler has not revisited since the column was added carries null
 * and is therefore not a wedge. That costs at most one pulse — the reconciler
 * fills it on the next pass over a still-blocked part — and it is the safe
 * direction, since the failure it replaces was escalating something that is not
 * one.
 *
 * **Every** live part, not any: one blocked part among several is a plan still
 * making progress, and the collision blocks all of them together or none — which
 * is reasoning that holds for the collision alone, and is the second reason this
 * cannot be asked of `blocked` in general. A plan with no live parts is not wedged
 * but empty, which is a different thing and is left to say so itself.
 */
export function planIsWedged(parts: PlanPart[]): boolean {
  const live = liveParts(parts);
  return live.length > 0 && live.every((p) => p.status === 'blocked' && p.blockedBy === 'ref-collision');
}

/**
 * The reason the parts carry, for quoting back.
 *
 * Read off the row rather than recomposed, so the escalation, the Goal Floor's
 * plate and the Errors panel are one sentence — `refCollisionReason` is written
 * once and read everywhere, and a second rendering here would be the drift that
 * predicate exists to prevent. Null when the rows carry none (an older database),
 * and the caller then says less rather than inventing it.
 *
 * Scoped to the collision, because both callers' prose is written about branches:
 * {@link wedgedPlanPrompt} follows it with "clear what is blocking the parts" and
 * "somewhere the branch is free", and a declined step's reason quoted into that
 * frame is two false sentences about a part that has no branch at all.
 */
function wedgeReason(parts: PlanPart[]): string | null {
  return liveParts(parts).find((p) => p.blockedBy === 'ref-collision' && p.blockedReason)?.blockedReason ?? null;
}

/**
 * Open pull requests for the issue that **no live part claims**.
 *
 * The interesting one is a PR on the flat `issue/<n>` branch, left by an unplanned
 * pickup: it is both the thing that blocks the parts and a real piece of work the
 * operator has open, and once a plan exists it belongs to nothing. `linkedPrNumber` is
 * included because it is the other way a PR is attached to an issue, and excluded
 * again when a part has claimed it — which is the ordinary case for a plan that is
 * working, where the sticky link points at whichever part opened last.
 */
function unclaimedIssuePrs(issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): PullRequest[] {
  const flat = issueBranch(issue.number);
  const live = liveParts(parts);
  const claimed = (pr: PullRequest): boolean =>
    live.some((p) => p.prNumber === pr.number || pr.branch === (p.branch ?? partBranch(issue.number, p.slug)));
  return openPrs.filter(
    (pr) => !pr.merged && !claimed(pr) && (pr.branch === flat || pr.number === issue.linkedPrNumber),
  );
}

/**
 * What an operator should know *before* releasing a plan — appended to the
 * approval ask, never interpolated into it.
 *
 * Appending is the rule the rejection note, the outstanding-work note and
 * `ciFailureNote` all follow, and for the same reason: `plan-approval` is
 * operator-overridable and `loadPromptTemplates` rejects only *unknown*
 * placeholders, so a `{warnings}` token would be silently dropped by exactly the
 * deployments that customised most — losing the warning on the installs most
 * likely to need it. Appending has no fallback to get wrong.
 *
 * It **warns and does not block**. Refusing to approve would put a git fact in
 * front of a judgement about *shape*: the decomposition may be exactly right, and
 * the branch is one command away from being gone, so a refusal would read as
 * permanent for a transient condition — and it would leave the operator's only
 * exit being a refusal, which is the opposite verdict to the one they were giving.
 *
 * Empty when there is nothing to say, so nothing is appended at all.
 */
export function planApprovalWarnings(issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): string {
  const lines: string[] = [];
  const reason = wedgeReason(parts);
  if (reason) lines.push(`- Its parts are already blocked and cannot be cut. ${reason}`);
  for (const pr of unclaimedIssuePrs(issue, parts, openPrs)) {
    lines.push(
      `- PR #${pr.number} ("${pr.title}", branch ${pr.branch}) is open for this issue and belongs to no part of ` +
        `this plan. Approving does not close it, hand it to a part, or count it towards the plan — nothing here ` +
        `knows which part, if any, it satisfies.`,
    );
  }
  return lines.length === 0 ? '' : `\n\nBefore you decide:\n\n${lines.join('\n')}`;
}

/**
 * The question put to a human once a released plan turns out to be going nowhere.
 *
 * It names the unclaimed pull request too, and for the reason the whole escalation
 * exists: {@link planApprovalWarnings} already said it, but approval can be days
 * behind the moment the operator is standing in front of the wedge, and "clear
 * what is blocking the parts" is unfollowable while a PR holds the branch open.
 * The one thing that is not said is which part the PR belongs to — see the header:
 * nothing here knows, and it is named and left alone.
 */
export function wedgedPlanPrompt(issueNumber: number, issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): string {
  const live = liveParts(parts);
  const reason = wedgeReason(parts);
  const prs = unclaimedIssuePrs(issue, parts, openPrs).map(
    (pr) =>
      `\n\nPR #${pr.number} ("${pr.title}") is open on ${pr.branch} and belongs to no part of this plan. While it ` +
      `is open the branch cannot be deleted, so it has to be merged or abandoned first — and nothing here knows ` +
      `which part, if any, it satisfies.`,
  );
  return (
    `The approved ${live.length}-part plan for issue #${issueNumber} ("${issue.title}") is not running: every one ` +
    `of its parts is blocked, so no agent has been dispatched and none will be.` +
    (reason ? ` ${reason}` : '') +
    prs.join('') +
    `\n\nTwo ways out, and the harness will not choose between them: clear what is blocking the parts and they ` +
    `start on the next pulse, or Replan from the plan sheet and let a planner cut the work somewhere the branch ` +
    `is free.`
  );
}
