import { dispatchVerdict } from '../dispatchCooldown.js';
import {
  charterNote,
  needsFleetReview,
  reviewTriageOrigin,
  routesBetweenModes,
  reviewModeNames,
} from '../../review/prReview.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Decide **how** a pull request should be reviewed, before deciding anything
 * about the code in it.
 *
 * The routing question is not a threshold. "Under three files" is a proxy for
 * risk, and the things that actually make a diff worth a careful read — it
 * touches auth, it is the first change in a subsystem, the ticket calls it a
 * spike — are not counted, they are judged. So the choice is a model's, made
 * against the project's own routing charter, and what comes back is a **mode
 * name** rather than prose: three things act on it before the reviewer reads a
 * line — the prompt, the charter appended to it, and the profile it runs on — and
 * an agent that only said which mode it would have used would leave all three on
 * the default with nothing to say so.
 *
 * **A desk agent, on metadata alone.** No worktree, no pool slot, no repository
 * read: it is handed the title, the branch, the base and the tracker's own words,
 * which is the shape of the change rather than its contents. A routing decision
 * that needed the diff would cost what the review costs, and then there would be
 * no saving left to route for.
 *
 * **Its own stage, above the PR-concern pass**, rather than an eighth concern in
 * it. The pass exists because at most one *branch* agent works a branch, and this
 * dispatches no branch agent at all — folding it in would have it compete for a
 * lease it never takes. Above, so the group below stays contiguous
 * ([05](docs/spec/05-dispatcher.md)).
 *
 * Fails open, exactly as the appraiser and the planner do: a triage that crashes,
 * is killed or spends its cap leaves no route, and `pr-review` then runs the
 * default mode rather than parking. A gate that can quietly stop the fleet is
 * worse than one that occasionally reads a diff more carefully than it needed to.
 */
export function prReviewTriage(s: StageContext): void {
  const { ctx } = s;
  // Nothing to choose between: with one mode, or none, the review runs what there
  // is. The switch is the modes themselves rather than a flag of its own, so the
  // two cannot disagree about whether routing happens.
  if (!routesBetweenModes(s.review)) return;
  // `ctx.world.pullRequests` is the dispatch world — the operator's ignore tag has
  // already taken the unwatched out of it (they survive on `s.openPrs`, which is
  // for resolving stacks and never for acting).
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue;
    // The same gate the review itself takes: a pull request already reviewed, or
    // one whose diff a human reviewer is about to have rewritten, needs no route.
    if (!needsFleetReview(pr, s.prReviews.get(pr.number) ?? null, s.review)) continue;
    if (s.prReviewRoutes.has(pr.number)) continue;

    const origin = reviewTriageOrigin(pr.number);
    if (s.activeOrigins.has(origin)) continue;
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    // Held or capped is the fail-open arm, and it is silent: `pr-review` reads the
    // absence of a route as the default mode and the pull request is still
    // reviewed, so there is nothing a human could usefully be asked here.
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Choose how to review PR #${pr.number}`;
    const reason = `PR #${pr.number} has no review mode yet, and this project declares ${reviewModeNames(s.review).length}.`;
    s.candidates.push({
      origin,
      rule: 'pr-review-triage',
      title,
      kind: 'desk',
      // No branch and no worktree: it reads no code, and a checkout would only be
      // a temptation to start the review it exists to route.
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt:
          s.templates.render('pr-review-triage', {
            number: pr.number,
            title: pr.title,
            branch: pr.branch,
            base: pr.baseBranch ?? s.defaultBranch,
            modes: reviewModeNames(s.review).join(', '),
          }) + charterNote(s.reviewCharters.routing, 'How this project chooses'),
        originRef: origin,
        originTitle: pr.title,
        rule: 'pr-review-triage',
        reason,
      } satisfies RawAction,
    });
  }
}
