import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueForPr } from '../../pr/prIssue.js';
import { issueOrigin } from '../../plans/planning.js';
import { currentPlanSummary, liveParts } from '../../plans/parts.js';
import { prBreadth, splitBranch, splitOrigin } from '../../pr/prSplit.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `pr-split`)

const NO_PLAN =
  'This issue has no plan, so there is nothing to correct. Report the concepts you found with `split_assess` ' +
  'and stop there — the record is what an operator reads, and cutting the work up is theirs to decide.';

export function prSplit(s: StageContext): void {
  const { ctx } = s;
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue;
    if (s.prSplits.has(pr.number)) continue;
    const breadth = prBreadth(pr, s.planning.fileBudget);
    if (breadth === null || !breadth.over) continue;

    const issue = issueForPr(pr, ctx.world.issues);
    if (issue === null) continue;

    const origin = splitOrigin(issue.number, pr.number);
    if (s.activeOrigins.has(origin)) continue;
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const plan = s.plansByOrigin.get(issueOrigin(issue.number));
    const parts = plan ? (ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [];
    const branch = splitBranch(pr.number);
    const title = `Is PR #${pr.number} one change or several?`;
    const reason =
      `PR #${pr.number} changes ${breadth.files} files, past the budget of ${s.planning.fileBudget}; ` +
      'nothing has asked whether it holds more than one concept.';
    s.candidates.push({
      origin,
      rule: 'pr-split',
      title,
      kind: 'code',
      branch,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, pr.branch),
        title,
        prompt: s.templates.render('pr-split', {
          number: pr.number,
          title: pr.title,
          branch: pr.branch,
          base: pr.baseBranch ?? s.defaultBranch,
          files: breadth.files,
          budget: s.planning.fileBudget,
          issue: issue.number,
          plan:
            plan && liveParts(parts).length > 0
              ? `The plan you would be correcting:\n\n${currentPlanSummary(plan, parts, s.prRefStyle)}`
              : NO_PLAN,
        }),
        originRef: origin,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · ${breadth.files} files changed`,
        rule: 'pr-split',
        reason,
      } satisfies RawAction,
    });
  }
}
