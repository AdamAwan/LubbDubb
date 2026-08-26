import type { ErrorRecorder } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Issue, IssueAppraisal, WorldEvent, WorldSnapshot } from '../types.js';
import { appraisalHold } from './appraisal.js';

interface AppraisalDeskDeps {
  store: Store;
  /** Outbound seam, for the one comment a refused goal maintains on its ticket. */
  sink: ActionSink;
  errors?: ErrorRecorder;
}

/**
 * The half of the goal appraisal that talks to the person who wrote the ticket.
 *
 * Issue #158's third decision: *"the most useful output may not be the gate at all
 * but a comment on the ticket — 'this is ambiguous, here is what I would need' —
 * which is actionable by the human who wrote it."* That is right, and it is what
 * makes a **blocking** gate fair rather than merely safe. Everything else the appraisal
 * produces lands in the cockpit, and the person who can end the hold in one edit is
 * usually not looking at the cockpit — so without this the harness would refuse a
 * ticket and tell only itself.
 *
 * Three things carry it, and each is taken from the plan status comment rather than
 * invented, because it is the same act:
 *
 * - **One living comment, edited in place** (`IssueCommentCapable.upsertIssueComment`
 *   plus a `comment_ref` on the row). A refused goal is a standing state, not a
 *   stream of news; a fresh comment per pulse would be the duplicate-question
 *   failure `proposalHold` exists to stop, wearing a thread instead of an inbox.
 *   The ref is dropped when the ticket's text changes (`Store.recordAppraisal`), so a
 *   genuinely new question gets a new comment rather than overwriting the record of
 *   the old one.
 * - **Written only when the body changes**, so a re-appraisal that says the same thing
 *   edits nothing.
 * - **A desk beside the plan reconciler, not an action through the executor.** It
 *   is mechanical bookkeeping in exactly the sense `set_work_item_state` and the
 *   plan comment are — nothing is deciding *whether* to send it — so it is
 *   deliberately not auto-send gated and does not pass through the proposal
 *   machinery. What keeps that from being a licence to chatter is the one-comment
 *   rule above.
 *
 * What it never does: close, reject, label or edit the ticket. The verdict informs
 * pickup and asks a question; issue #158 puts all three of those out of scope, and
 * this comment is the *only* outbound act the appraisal performs.
 */
export class AppraisalDesk {
  /**
   * What was last written per issue, so an unchanged body is not re-sent. In memory
   * rather than a column: the cost of losing it across a restart is one redundant
   * edit of a comment that already says the right thing.
   */
  private readonly lastBody = new Map<string, string>();

  constructor(private readonly deps: AppraisalDeskDeps) {}

  /**
   * Post or update the comment for every issue carrying an `unclear` verdict.
   *
   * Runs on the pulse, beside `PlanReconciler.reconcile`, and is driven off the
   * *current* verdicts rather than off "rows written since last time": a hold that
   * ended because the ticket was edited needs its comment resolved, and a verdict
   * cast while the provider was unreachable needs its comment written late. Both
   * fall out of re-deriving the state each pulse; neither would from a queue of
   * events to replay.
   */
  async announce(world: WorldSnapshot, signals: WorldEvent[]): Promise<void> {
    const appraisals = new Map(this.deps.store.listAppraisals().map((a) => [a.originRef, a]));
    if (appraisals.size === 0) return;
    for (const issue of world.issues) {
      const appraisal = appraisals.get(`issue:${issue.number}`);
      if (!appraisal || appraisal.verdict !== 'unclear') continue;
      // An expired verdict is still written — to say it expired. Leaving the
      // question standing on the thread after the harness stopped asking it is what
      // makes people stop believing a bot's comments.
      const held = appraisalHold(appraisal, issue, { signals }) !== null;
      if (!held && appraisal.commentRef === null) continue; // never asked; nothing to retract
      const body = renderAppraisalComment(appraisal, held);
      if (appraisal.commentRef !== null && body === this.lastBody.get(appraisal.originRef)) continue;
      await this.write(issue, appraisal, body);
    }
  }

  private async write(issue: Issue, appraisal: IssueAppraisal, body: string): Promise<void> {
    try {
      const result = await this.deps.sink.upsertIssueComment({
        number: issue.number,
        body,
        commentRef: appraisal.commentRef,
      });
      this.lastBody.set(appraisal.originRef, body);
      if (result.ref && result.ref !== appraisal.commentRef)
        this.deps.store.setAppraisalComment(appraisal.originRef, result.ref);
    } catch (err) {
      // Asking the question must never take the pulse down with it — the verdict
      // still holds, the cockpit still shows it, and the failure lands in Errors.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Could not update the goal appraisal comment on #${issue.number}: ${(err as Error).message}`,
      });
    }
  }
}

/**
 * The comment body. Pure, so what a human reads on the ticket is exactly what the
 * gate believes — the property `renderPlanComment` is pure for.
 *
 * Addressed to whoever wrote the ticket and phrased as a question rather than a
 * refusal, because that is what it is: the harness is not rejecting the item, it is
 * saying it cannot start. It names its own escape routes, since a reader who does
 * not know that an edit ends the hold will assume they need an operator.
 */
export function renderAppraisalComment(appraisal: IssueAppraisal, held: boolean): string {
  if (!held) {
    return (
      `${MARKER}\n\n**No longer waiting on this.** Something has changed here since the question below ` +
      `was asked, so LubbDubb will look at this item again.\n\n> ${quote(appraisal.summary)}`
    );
  }
  return (
    `${MARKER}\n\n**Nothing is scheduled for this yet — I could not work out what to do from the ` +
    `description.**\n\n> ${quote(appraisal.summary)}\n\nEditing this item, or replying here, is enough: ` +
    `either makes LubbDubb look again on its next pass. Nothing has been rejected and nothing is closed.`
  );
}

/** Identifies the comment as the harness's, for anyone reading the thread cold. */
const MARKER = '<!-- lubbdubb:appraisal -->\n_LubbDubb goal check_';

/** Keep a multi-line summary inside the blockquote rather than escaping it halfway. */
function quote(text: string): string {
  return text.trim().replace(/\n/g, '\n> ');
}
