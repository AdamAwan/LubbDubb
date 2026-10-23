import { openPrForIssue } from '../issuePickup.js';
import { issueOriginRole } from '../../issueOrigins.js';
import { isActiveTask } from '../../tasks.js';
import type { Issue, TaskSummary } from '../../types.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `work-item-in-progress`)

export function liveWorkTask(s: StageContext, issue: Issue): TaskSummary | undefined {
  return s.ctx.tasks.find((t) => isActiveTask(t) && issueOriginRole(issue.number, t.originRef) === 'work');
}

export function workItemInProgress(s: StageContext): void {
  if (!s.workItemInProgress) return;
  const { inProgressState, pickupStates } = s.workItemInProgress;
  for (const issue of s.ctx.world.issues) {
    if (s.retained.has(issue.number)) continue;
    const state = issue.workItemState;
    if (state === undefined || issue.state !== 'open') continue;
    if (!pickupStates.includes(state)) continue;
    if (state === inProgressState) continue;
    if (openPrForIssue(issue, s.openPrs)) continue;
    const task = liveWorkTask(s, issue);
    if (!task) continue;
    s.raw.push({
      type: 'set_work_item_state',
      number: issue.number,
      state: inProgressState,
      rule: 'work-item-in-progress',
      reason:
        `An agent is working work item #${issue.number} (task on ${task.originRef}); ` +
        `move it from "${state}" to "${inProgressState}" so the board shows the work in flight.`,
    } satisfies RawAction);
  }
}
