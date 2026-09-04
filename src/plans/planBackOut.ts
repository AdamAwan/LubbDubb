import type { Config } from '../config.js';
import type { ErrorLog } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { applyIssueWatch } from '../issueWatch.js';
import { originIssueNumber } from './planning.js';
import { declinePlan, refusePlan } from './planApproval.js';

/**
 * The two ways out of a plan verdict that are not a verdict *on the plan*.
 *
 * Approve and Reject are the two answers to "is this the right plan": yes, or
 * no-write-another-one. Both of them agree the work is worth doing — a rejection
 * sends the goal straight back to a planner, which is why it is the wrong button
 * for the operator who has just read a plan and realised the *ticket* is the
 * problem. They pressed it anyway, because it was the only "no" on the card, and
 * the harness answered by re-planning a goal nobody wanted until the planner's
 * attempt cap ran out.
 *
 * So there are two more, and they are deliberately about the **ticket**:
 *
 * - **`close`** — this is not really an issue, or it is not worth doing. The
 *   operator's words go on the tracker item as a comment, the item is closed where
 *   the provider can close it, the goal is concluded in the harness's own record so
 *   nothing picks it up again, and the plan is abandoned.
 * - **`hold`** — this needs more thought before anyone works it. Nothing is
 *   concluded and nothing is commented: the watch tag comes off, which is the one
 *   shape in which "leave this alone" cannot be argued with, and the plan is
 *   **refused** — `refusePlan`, the same settlement Reject makes, so it goes back
 *   to `planning` with the operator's words on its reason and its unstarted parts
 *   retired. Un-watched, `issue-plan` dispatches nothing, so the refusal sits
 *   there costing nothing; watching the ticket again is what starts a planner, and
 *   what comes back is a **new plan** written in the light of why it was held.
 *
 *   Leaving the plan `awaiting_approval` instead was the first shape of this, and
 *   it is the wrong one: a hold says the thinking is not finished, and re-proposing
 *   the *same* decomposition weeks later asks the operator to approve a plan
 *   written before whatever they were waiting on happened.
 *
 * Both are settled through {@link ProposalDesk}, so the proposal's one-way
 * transition, the inbox item and the audit row are the ones every other verdict
 * gets. What is new here is only what happens to the ticket.
 */
export type BackOutVerdict = 'close' | 'hold';

/** Everything backing out of a plan touches beyond the store: the tracker, and the error log. */
export interface BackOutContext {
  store: Store;
  /** The one outbound seam — the comment, the close and the watch tag all go through it. */
  sink: ActionSink;
  config: Pick<Config, 'labelPrefix' | 'issueContainerTypes'>;
  errors: ErrorLog;
}

/** What the back-out did, as the audit line and the route both read it. */
interface BackOutResult {
  ok: boolean;
  /** The audit clause, in the operator's terms: what happened to the ticket and to the plan. */
  detail: string;
}

/**
 * Back out of a plan the operator does not want worked — see {@link BackOutVerdict}
 * for which of the two this is and why they are different acts.
 *
 * **Every step is best effort and each is reported**, which is the one thing this
 * function is careful about. It makes up to four writes across two systems, and a
 * partial failure is the normal case worth designing for — a tracker that refuses
 * the close still took the comment, and an operator told "closed" over a ticket
 * that is still open has been lied to about the thing they were deciding. So each
 * write's outcome lands in `detail` and every failure goes through
 * `errors.record`, and the harness's own half — the conclusion and the plan
 * settlement — is written **first**, because it is the half that actually stops
 * the fleet.
 */
export async function backOutOfPlan(
  ctx: BackOutContext,
  act: { planId: string; originRef: string },
  verdict: BackOutVerdict,
  note: string | null,
): Promise<BackOutResult> {
  const { store } = ctx;
  const issueNumber = originIssueNumber(act.originRef);
  if (issueNumber === null) return { ok: false, detail: `${act.originRef} names no issue to back out of` };

  const done: string[] = [];

  // The plan first, either way: it is the harness's own record, it is what stops
  // the fleet, and it is the only step that cannot fail on somebody else's network.
  // The two verdicts differ in which settlement — a close ends the plan, a hold
  // refuses it so the goal is planned afresh whenever it is picked back up.
  if (verdict === 'hold') {
    done.push(refusePlan(store, act.planId, act.originRef, note).detail);
  }

  if (verdict === 'close') {
    const settled = declinePlan(store, act.planId, act.originRef, note);
    done.push(settled.detail);
    store.recordIssueConclusion({
      originRef: issueConclusionOrigin(issueNumber),
      verdict: 'done',
      note: note ?? 'An operator closed this ticket from the plan approval card.',
      by: 'operator',
    });
    done.push('concluded the goal, so nothing picks it up again');
  }

  // The tag, both ways round: a closed ticket that kept the watch tag comes back
  // the day somebody reopens it, and on a hold it is the whole of what stops the
  // replan the refusal above would otherwise have a planner start on the next
  // pulse. Written through the same cascade the cockpit's own toggle uses, so
  // dropping a Feature drops the stories under it rather than leaving them tagged
  // and still worked.
  done.push(await unwatch(ctx, issueNumber));

  if (verdict === 'close') {
    done.push(await comment(ctx, issueNumber, note));
    done.push(await closeTicket(ctx, issueNumber));
  }

  return { ok: true, detail: done.join('; ') };
}

/**
 * Take the watch tag off — the whole of `hold`, and the belt to the close's
 * braces. A failure is reported rather than swallowed, for the toggle's reason:
 * an operator told the ticket is on hold, whose tag is still on it, will find the
 * fleet working it.
 */
async function unwatch(ctx: BackOutContext, issueNumber: number): Promise<string> {
  const { store, config, errors } = ctx;
  // The cascade and both mirrors are `src/issueWatch.ts`, shared with the cockpit's
  // toggle and the desktop channel: three copies of one write is three places for
  // the Tickets mirror to be forgotten. What is this desk's own is the sentence it
  // reports back with.
  const outcome = await applyIssueWatch(
    { store, sink: ctx.sink, errors, labelPrefix: config.labelPrefix, issueContainerTypes: config.issueContainerTypes },
    issueNumber,
    false,
    `while backing out of #${issueNumber}`,
  );
  if (!outcome.label) return 'left the watch tag alone (this deployment configures no label prefix)';
  const { targets, landed, failed } = outcome;
  if (failed.length === 0) return `dropped the watch tag on ${targets.length} item(s)`;
  return `dropped the watch tag on ${landed.length} of ${targets.length} item(s) — #${failed.map((f) => f.number).join(', #')} kept it`;
}

/** The operator's words on the ticket itself. A fresh comment, never an edit of the plan's living one. */
async function comment(ctx: BackOutContext, issueNumber: number, note: string | null): Promise<string> {
  if (note === null) return 'posted no comment (none was given)';
  try {
    await ctx.sink.upsertIssueComment({ number: issueNumber, body: note, commentRef: null });
    return `commented on #${issueNumber}`;
  } catch (err) {
    const message = (err as Error).message;
    ctx.errors.record({
      source: 'server',
      message: `Failed to comment on #${issueNumber} while closing it: ${message}`,
    });
    return `could not comment on #${issueNumber} (${message}) — your words are on the decision instead`;
  }
}

/**
 * Close the tracker item, where the provider has a close at all.
 *
 * Where it does not — Azure, whose "we are not doing this" is a state word out of
 * a process template the harness has no business choosing — this is said plainly
 * rather than approximated. The goal is concluded and un-watched either way, so
 * the fleet is stopped; what is left is a human moving the card, which is what it
 * has always been on that provider.
 */
async function closeTicket(ctx: BackOutContext, issueNumber: number): Promise<string> {
  if (!ctx.sink.canCloseIssue())
    return `left #${issueNumber} open — this tracker has no close the harness can write, so that stays a human act`;
  try {
    await ctx.sink.closeIssue({ number: issueNumber, reason: 'not_planned' });
    return `closed #${issueNumber} as not planned`;
  } catch (err) {
    const message = (err as Error).message;
    ctx.errors.record({
      source: 'server',
      message: `Failed to close #${issueNumber} from the plan back-out: ${message}`,
    });
    return `could not close #${issueNumber} (${message}) — it is un-watched, so nothing will work it`;
  }
}
