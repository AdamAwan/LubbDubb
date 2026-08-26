import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { retroOrigin } from '../../retro/retro.js';
import { issueOrigin } from '../../plans/planning.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Write up a goal the harness has parked as delivered.
 *
 * The Goal Floor's Manifest station has always named this step and the harness has
 * never taken it: the station drew `issue.conclusion?.note` or an em dash, and
 * nothing anywhere produced an account of the run. This is that account.
 *
 * Ranked after the assessor — an issue whose delivery is still being judged is not
 * one to write up — and it suppresses nothing, because a delivered issue is
 * already out of `issue-pickup` through `deliveryHold`. It gates nothing at all: a
 * goal is delivered whether or not anybody wrote it up, which is what makes the
 * fail-open below cost only the report.
 */
export function issueRetro(s: StageContext): void {
  const { ctx } = s;
  const written = new Set(ctx.retrospectiveOrigins ?? []);
  for (const issue of ctx.world.issues) {
    // Deliberately **not** gated on `retained` (issue #234): with `issue-assess`,
    // this is one of the two rules the union exists for. Both run after the work
    // is over, which is exactly when a delivering PR has already closed the
    // ticket — the run is what they belong to, not the tracker's answer.
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    const root = issueOrigin(issue.number);
    if (written.has(root)) continue;
    // The harness's *own* park is the signal, not the tracker's `closed`: it is
    // what `deliveryHold` reads, and it exists precisely for the providers that
    // have no review state to move an item into.
    if (!s.deliveryParked(issue)) continue;
    // Anything live under the issue — a part, a late pickup, a previous retro
    // agent — means the run is not over yet.
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const origin = retroOrigin(issue.number);
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    // Fails open and *silent*, for the appraiser's reason and more cheaply than
    // any of them: nothing is gated on a retrospective, so a spent cap costs the
    // write-up and nothing else. No escalation — there is nothing a human can do
    // about a report that did not happen that they cannot do by reading the issue.
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Write up issue #${issue.number}`;
    const reason = `Issue #${issue.number} is delivered and has no retrospective; write the run up.`;
    s.candidates.push({
      origin,
      rule: 'issue-retro',
      title,
      kind: 'desk',
      // No branch and no worktree: it writes no files, and a checkout would only
      // be a temptation to start work on a goal that is finished.
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt: s.templates.render('issue-retro', {
          number: issue.number,
          title: issue.title,
          body: issue.body,
        }),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-retro',
        reason,
      } satisfies RawAction,
    });
  }
}
