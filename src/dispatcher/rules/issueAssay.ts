import { dispatchVerdict } from '../dispatchCooldown.js';
import { assayBranch, assayOrigin, hasWorkStarted, isAssayed } from '../../intake/assay.js';
import { issueOrigin } from '../../plans/planning.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Check the goal before anything is dispatched against it (issue #158).
 *
 * The gap this closes: every gate an issue passes on its way to an agent asks
 * about policy — the watch tag, the workflow state, the cooldown, the attempt cap,
 * headroom, `resolvePlanRoute` — and none of them asks whether the ticket says
 * anything an agent could act on. So a vague or already-obsolete issue goes
 * straight into the funnel, and the first sign anything was wrong is an agent
 * spending its attempt cap and escalating in a way that reads as its own failure.
 *
 * Ranked ahead of the planner and suppressing it for the same issue, for
 * `issue-plan`'s own reason pointed one stage earlier: a planner *unblocks* work,
 * and decomposing a goal nobody could answer is the specific waste this exists to
 * stop — the operator would be asked to approve a decomposition of a question.
 * The suppression is `s.assaying`, written here and read by the two stages below
 * (see {@link StageContext}).
 *
 * Fires only for an issue nothing has been started for. `hasWorkStarted` is the
 * same discriminator `issue-assess` uses, taking the other arm: nothing started
 * means the goal is still the only thing there is to judge, something started
 * means the question has been answered by someone acting on it (and, once it
 * finishes, it is the assessor's). An issue that already has a plan is likewise
 * past this gate — the funnel has read it — so a plan row skips it whatever its
 * status.
 */
export function issueAssay(s: StageContext): void {
  const { ctx } = s;
  for (const { issue } of s.eligibleIssues) {
    // Already judged, and judged against *this* text — an edited ticket
    // fingerprints differently and is assayed again, which is the same
    // comparison that ends a hold (see `assayHold`).
    if (isAssayed(s.assays.get(issueOrigin(issue.number)) ?? null, issue)) continue;
    if (hasWorkStarted(issue.number, ctx.tasks)) continue;
    if (s.plansByOrigin.has(issueOrigin(issue.number))) continue;
    const root = issueOrigin(issue.number);
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const origin = assayOrigin(issue.number);
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    // Fails open, exactly as the planner and the assessor do: a spent cap
    // returns the issue to the funnel it would have entered anyway, with no
    // escalation. Without it, every assayer crash is a permanently parked
    // issue — which would make this gate the most effective way to stop the
    // harness working, the failure issue #158 names in its first decision.
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    s.assaying.add(issue.number);
    const branch = assayBranch(issue.number);
    const title = `Assay issue #${issue.number}`;
    const reason = `Nothing has been started for issue #${issue.number}; check the goal can be worked from before dispatching against it.`;
    s.candidates.push({
      origin,
      rule: 'issue-assay',
      title,
      kind: 'code',
      branch,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        branch,
        // Cut from the default branch: the question is whether this goal makes
        // sense against the repository as it stands.
        base: s.defaultBranch,
        title,
        prompt: s.templates.render('issue-assay', {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          branch,
        }),
        originRef: origin,
        // The exact text the verdict will be fingerprinted against — see
        // `AgentManager.recordAssay`, which reads these two fields back off
        // the task rather than re-reading the issue.
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-assay',
        reason,
      } satisfies RawAction,
    });
  }
}
