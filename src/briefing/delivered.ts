import { prState } from '../prHealth.js';
import type { PullRequest } from '../types.js';

/**
 * Where a goal's merges are **in the checkout the assessor is standing in**.
 *
 * ## The gap, stated narrowly, because most of it is not one
 *
 * Rule `issue-assess` is dispatched into a read-only checkout of the default
 * branch to read the story again against the code. What was done for the goal it
 * already has: the `issue-assess` template sends it to `world_read`, whose issue
 * read carries the plan graph and the whole work subtree — every delivering pull
 * request as a node with its title, its status and its `observed` / `inferred`
 * provenance ([11](docs/spec/11-mcp-tools.md#world_read)). Restating that here
 * would be the second account of something the harness already says that
 * `priorWork.ts` and `retroDossier` both refuse, and it would be the *staler*
 * account besides.
 *
 * Two fields are not in it, and they are the two that turn a pull request number
 * into something the agent can actually look at:
 *
 * - **the merge commit**, which git cannot recover. A squash merge leaves the
 *   branch with no ancestry link to its base ([24](docs/spec/24-environments.md#recording-a-landing)),
 *   so an assessor holding `#40 (merged)` and standing on the default branch has
 *   no route from the number to the diff but to search the log for it;
 * - **the branch**, which is the fallback route where no merge commit was ever
 *   reported, and the only one for a pull request that was abandoned.
 *
 * So this is deliberately not a briefing about what the goal delivered. It is an
 * index into the checkout: one line per pull request, and the record of what it
 * was for stays where it already is.
 *
 * ## It says where to look, never what happened
 *
 * Every line is a stored field quoted back — a number, a branch, a commit. No
 * summary, no ranking, no "these look complete": the assessor's whole job is to
 * decide whether the story was met, and a block with an opinion about that would
 * be answering the question it was sent to ask.
 *
 * ## The outcome is three-valued
 *
 * `GitObserver.contains`' rule ([24](docs/spec/24-environments.md#the-three-verdicts)).
 * A row whose last reading was `open` left the open set without the harness ever
 * seeing how, and folding that into "closed without merging" tells an assessor
 * that work which in fact shipped was abandoned — which it writes up as a
 * shortfall against a delivered goal.
 *
 * ## Bounded, and what the cap dropped is named
 *
 * Appended text is fresh input tokens on every dispatch. Over {@link MAX_PRS} the
 * **oldest** go, `priorWork.ts`'s choice, and the count that went is stated: an
 * assessor reading a truncated list as the whole one concludes from the absence of
 * a pull request that was merely trimmed. A goal with nothing recorded renders the
 * empty string and is filtered out at the call site, so its prompt is
 * byte-identical to one composed before this existed.
 */

/** Pull requests beyond this are dropped — the oldest first, and said so. */
const MAX_PRS = 25;

/**
 * How a pull request ended and where to find it, in the harness's own words.
 *
 * The merge commit leads and the branch follows it, because on a merged pull
 * request the commit is the route that works from where the agent is standing and
 * the branch may not exist in the checkout at all.
 */
function whereToLook(pr: PullRequest): string {
  const when = pr.closedAt ? ` ${pr.closedAt}` : '';
  switch (prState(pr)) {
    case 'merged':
      return pr.mergeCommitSha
        ? `merged${when} as ${pr.mergeCommitSha} (branch ${pr.branch})`
        : `merged${when}, no merge commit recorded — branch ${pr.branch}`;
    case 'closed':
      return `closed without merging${when} — branch ${pr.branch}`;
    default:
      return `branch ${pr.branch}; the harness never recorded how it ended`;
  }
}

/** The block appended to an assessor's prompt, or `''` when the harness recorded nothing. */
export function deliveredWorkBriefing(prs: readonly PullRequest[]): string {
  const kept = prs.slice(0, MAX_PRS);
  if (kept.length === 0) return '';
  const dropped = prs.length - kept.length;

  const lines = [
    'Where this goal’s pull requests are in the checkout you are in, most recently closed first. This ' +
      'is the harness’s record of each one as it last read it, and it is only the part `world_read` ' +
      'does not carry — ask that for what each pull request was for and how confident the harness is ' +
      'that it merged. A squash merge leaves no ancestry link, so the commit below is the route from ' +
      'the number to the diff:',
  ];
  for (const pr of kept) lines.push(`- #${pr.number} — ${whereToLook(pr)}`);
  if (dropped > 0)
    lines.push(
      `[${dropped} older pull request${dropped === 1 ? '' : 's'} of this goal ${dropped === 1 ? 'was' : 'were'} ` +
        'trimmed to fit — `world_read` has the whole subtree.]',
    );
  return lines.join('\n');
}
