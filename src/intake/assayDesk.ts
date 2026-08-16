import type { ErrorRecorder } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Issue, IssueAssay, WorldEvent, WorldSnapshot } from '../types.js';
import { assayHold } from './assay.js';

interface AssayDeskDeps {
  store: Store;
  /** Outbound seam, for the one comment a refused goal maintains on its ticket. */
  sink: ActionSink;
  errors?: ErrorRecorder;
}

/**
 * The half of the goal assay that talks to the person who wrote the ticket.
 *
 * Issue #158's third decision: *"the most useful output may not be the gate at all
 * but a comment on the ticket — 'this is ambiguous, here is what I would need' —
 * which is actionable by the human who wrote it."* That is right, and it is what
 * makes a **blocking** gate fair rather than merely safe. Everything else the assay
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
 *   The ref is dropped when the ticket's text changes (`Store.recordAssay`), so a
 *   genuinely new question gets a new comment rather than overwriting the record of
 *   the old one.
 * - **Written only when the body changes**, so a re-assay that says the same thing
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
 * this comment is the *only* outbound act the assay performs.
 */
export class AssayDesk {
  /**
   * What was last written per issue, so an unchanged body is not re-sent. In memory
   * rather than a column: the cost of losing it across a restart is one redundant
   * edit of a comment that already says the right thing.
   */
  private readonly lastBody = new Map<string, string>();

  constructor(private readonly deps: AssayDeskDeps) {}

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
    const assays = new Map(this.deps.store.listAssays().map((a) => [a.originRef, a]));
    if (assays.size === 0) return;
    for (const issue of world.issues) {
      const assay = assays.get(`issue:${issue.number}`);
      if (!assay || assay.verdict !== 'unclear') continue;
      // An expired verdict is still written — to say it expired. Leaving the
      // question standing on the thread after the harness stopped asking it is what
      // makes people stop believing a bot's comments.
      const held = assayHold(assay, issue, { signals }) !== null;
      if (!held && assay.commentRef === null) continue; // never asked; nothing to retract
      const body = renderAssayComment(assay, held);
      if (assay.commentRef !== null && body === this.lastBody.get(assay.originRef)) continue;
      await this.write(issue, assay, body);
    }
  }

  private async write(issue: Issue, assay: IssueAssay, body: string): Promise<void> {
    try {
      const result = await this.deps.sink.upsertIssueComment({
        number: issue.number,
        body,
        commentRef: assay.commentRef,
      });
      this.lastBody.set(assay.originRef, body);
      if (result.ref && result.ref !== assay.commentRef) this.deps.store.setAssayComment(assay.originRef, result.ref);
    } catch (err) {
      // Asking the question must never take the pulse down with it — the verdict
      // still holds, the cockpit still shows it, and the failure lands in Errors.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Could not update the goal assay comment on #${issue.number}: ${(err as Error).message}`,
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
export function renderAssayComment(assay: IssueAssay, held: boolean): string {
  if (!held) {
    return (
      `${MARKER}\n\n**No longer waiting on this.** Something has changed here since the question below ` +
      `was asked, so LubbDubb will look at this item again.\n\n> ${quote(assay.summary)}`
    );
  }
  return (
    `${MARKER}\n\n**Nothing is scheduled for this yet — I could not work out what to do from the ` +
    `description.**\n\n> ${quote(assay.summary)}\n\nEditing this item, or replying here, is enough: ` +
    `either makes LubbDubb look again on its next pass. Nothing has been rejected and nothing is closed.`
  );
}

/** Identifies the comment as the harness's, for anyone reading the thread cold. */
const MARKER = '<!-- lubbdubb:assay -->\n_LubbDubb goal check_';

/** Keep a multi-line summary inside the blockquote rather than escaping it halfway. */
function quote(text: string): string {
  return text.trim().replace(/\n/g, '\n> ');
}
