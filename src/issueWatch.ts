import type { ErrorRecorder } from './errorLog.js';
import { watchCascadeTargets } from './issueRelations.js';
import type { IssueLabelInput, SendResult } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import { watchLabelFor } from './watchLabels.js';

/**
 * Writing the watch tag on a goal, in one place.
 *
 * Three callers reach it and each of them had grown its own copy: the cockpit's
 * toggle (`POST /api/issues/:number/watch`), the plan back-out's `hold`, and the
 * desktop channel's `goal_control`. The copies agreed today and had no reason to
 * keep agreeing — and the two facts they share are the ones nothing would catch
 * going wrong.
 *
 * **A container cascades.** Watching a Feature tags every descendant beneath it
 * ({@link watchCascadeTargets}), because a container is never worked itself: a tag
 * on one alone is a click that changes nothing. Un-watching walks the same tree,
 * or a dropped feature leaves its stories tagged and still worked.
 *
 * **Both mirrors are patched, and they are two readings rather than a copy.**
 * `/api/state` serves the world baseline; the Tickets tab is built from
 * `tracker_items` and never from the baseline. The sweep that would carry either
 * runs last in a cycle, and a cycle coalesces away to nothing while another is in
 * flight — so a surface redrawn before the next sweep shows the old tag on both.
 *
 * A partial failure is **reported**, never swallowed: an operator told "watched"
 * while three of eight children kept the old tag has been lied to about what the
 * harness will pick up. Whatever landed is patched anyway, because the world is
 * now different from the one the caller is showing even when the write failed
 * half way.
 */
export interface IssueWatchContext {
  store: Pick<Store, 'getWorldBaseline' | 'patchWorldLabels' | 'patchTicketLabels'>;
  /** The outbound seam — `system.connector` for a route, the `ActionSink` for a desk. */
  sink: { setIssueLabel(input: IssueLabelInput): Promise<SendResult> };
  /** Optional only because the desktop channel's server may be built without one. */
  errors?: ErrorRecorder;
  labelPrefix: string;
  issueContainerTypes: string[];
}

interface IssueWatchOutcome {
  /** The label written, or `''` where the deployment configures no prefix — see below. */
  label: string;
  /** Every item the cascade resolved, the named one included. */
  targets: number[];
  /** The subset the provider took. */
  landed: number[];
  failed: { number: number; message: string }[];
}

/**
 * Set or clear the watch tag on one goal and everything beneath it.
 *
 * `because` is the phrase the error log names the act by — "while watching #12",
 * "while backing out of #12" — so a failure reads as the thing the operator did
 * rather than as a bare label write.
 *
 * **An empty `labelPrefix` writes nothing**, and says so through an empty `label`
 * rather than through an empty `targets`. The gate is off on such a deployment:
 * everything is watched and there is no tag to put on, so a write would ask the
 * provider for a label with no name.
 */
export async function applyIssueWatch(
  ctx: IssueWatchContext,
  issueNumber: number,
  watched: boolean,
  because: string,
): Promise<IssueWatchOutcome> {
  const label = watchLabelFor(ctx.labelPrefix);
  if (!label) return { label, targets: [], landed: [], failed: [] };

  const world = ctx.store.getWorldBaseline();
  const issue = world?.issues.find((i) => i.number === issueNumber);
  // An issue the snapshot does not carry still gets its own tag written — the
  // toggle must keep working for a world that has aged out — it simply has no
  // hierarchy to walk.
  const targets =
    issue === undefined ? [issueNumber] : watchCascadeTargets(issue, world?.issues ?? [], ctx.issueContainerTypes);

  const landed: number[] = [];
  const failed: { number: number; message: string }[] = [];
  for (const target of targets) {
    try {
      await ctx.sink.setIssueLabel({ number: target, label, present: watched });
      landed.push(target);
    } catch (err) {
      const message = (err as Error).message;
      failed.push({ number: target, message });
      ctx.errors?.record({
        source: 'server',
        message: `Failed to ${watched ? 'set' : 'drop'} the watch tag on #${target} ${because}: ${message}`,
      });
    }
  }

  ctx.store.patchWorldLabels({ issues: landed, label, present: watched });
  ctx.store.patchTicketLabels({ numbers: landed, label, present: watched });
  return { label, targets, landed, failed };
}
