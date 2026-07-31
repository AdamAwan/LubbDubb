import type { Issue, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { liveParts, partBranch, partHasWork } from './parts.js';

/**
 * A decomposition that cannot proceed, and what the harness says about it.
 *
 * ## The gap this closes
 *
 * The ref-collision guard is correct and complete: `refs/heads/issue/12` blocks
 * every `refs/heads/issue/12/<slug>`, so the reconciler parks the parts `blocked`
 * and says so. What it does not do is *reach anyone*. The Errors panel is a feed,
 * and a feed carries news; the plan's own status comment reports progress, and a
 * plan with no progress reports none. So an issue worked `single` first, replanned,
 * and then approved onto its own taken branch had two red assemblers, no agent, no
 * question in "Needs you", and no route out — `refusePlan` compare-and-sets against
 * `awaiting_approval`, so the fall-back-to-`single` arm is gone the moment the
 * decomposition is approved, and `resolvePlanRoute` fails a spent replan back to
 * `parts` rather than open to `single`.
 *
 * Three separate things were missing and they are kept separate here: a way to
 * *notice* ({@link planIsWedged}), a way to *warn before it happens*
 * ({@link planApprovalWarnings}), and a way *out* (`abandonDecomposition`, beside
 * the other plan verdicts in `planApproval.ts`).
 *
 * ## What is deliberately not here
 *
 * **Nothing attaches the existing pull request to a part.** The single-arm PR
 * claims to resolve the whole issue — which is precisely the claim the
 * decomposition overruled — so nothing in the harness knows which part, if any, it
 * satisfies. Deriving that would be inferring a positive terminal from incidental
 * evidence, refused at every other point in this codebase (`undeclared` vs
 * `more_work`, the DONE sentinel vs the `result` event, `conclude_part` refusing
 * `kind: 'code'`). The PR is *named* to the operator and left alone.
 */

/**
 * Is every live part of this plan blocked?
 *
 * The plan is then doing nothing and will go on doing nothing until someone acts:
 * the only thing that blocks a part is the ref collision (`PlanReconciler.readiness`
 * answers `pending` or `ready` and never `blocked`), and a collision is a branch
 * that will not disappear on its own.
 *
 * **Every** live part, not any: one blocked part among several is a plan still
 * making progress, and the collision blocks all of them together or none. A plan
 * with no live parts is not wedged but empty, which is a different thing and is
 * left to say so itself.
 */
export function planIsWedged(parts: PlanPart[]): boolean {
  const live = liveParts(parts);
  return live.length > 0 && live.every((p) => p.status === 'blocked');
}

/**
 * The reason the parts carry, for quoting back.
 *
 * Read off the row rather than recomposed, so the escalation, the Goal Floor's
 * plate and the Errors panel are one sentence — `refCollisionReason` is written
 * once and read everywhere, and a second rendering here would be the drift that
 * predicate exists to prevent. Null when the rows carry none (an older database),
 * and the caller then says less rather than inventing it.
 */
function wedgeReason(parts: PlanPart[]): string | null {
  return liveParts(parts).find((p) => p.blockedReason)?.blockedReason ?? null;
}

/**
 * Open pull requests for the issue that **no live part claims**.
 *
 * The interesting one is the single-arm PR on the flat `issue/<n>` branch: it is
 * both the thing that blocks the parts and a real piece of work the operator has
 * open, and after a decomposition it belongs to nothing. `linkedPrNumber` is
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
 * What an operator should know *before* releasing a decomposition — appended to
 * the approval ask, never interpolated into it.
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

/** The question put to a human once a released plan turns out to be going nowhere. */
export function wedgedPlanPrompt(issueNumber: number, issue: Issue, parts: PlanPart[]): string {
  const live = liveParts(parts);
  const reason = wedgeReason(parts);
  return (
    `The approved ${live.length}-part plan for issue #${issueNumber} ("${issue.title}") is not running: every one ` +
    `of its parts is blocked, so no agent has been dispatched and none will be.` +
    (reason ? ` ${reason}` : '') +
    `\n\nTwo ways out, and the harness will not choose between them: clear what is blocking the parts and they ` +
    `start on the next pulse, or abandon the decomposition and work the issue as a single pull request ` +
    `(the plan panel's control, available while no part has started).`
  );
}

/**
 * Can this decomposition still be abandoned — and if not, why not?
 *
 * Pure so the route's refusal and the cockpit's control are the same answer. The
 * bar is `partHasWork`, the existing statement of "something was started for this
 * part": retiring one with an agent, a branch or a PR behind it would strand real
 * work, which is the rule `partsToRetire` already enforces for an amendment.
 */
export function abandonBlockers(parts: PlanPart[]): string[] {
  return liveParts(parts)
    .filter(partHasWork)
    .map((p) => `"${p.slug}" is ${p.status}`);
}
