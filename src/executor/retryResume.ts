import type { Store } from '../store/store.js';
import type { Agent } from '../types.js';

// → docs/spec/09-execution.md

export interface RetryResume {
  previous: Agent;
  priorAttempts: number;
}

export function retryResumeFor(originRef: string | null | undefined, store: Store): RetryResume | null {
  if (!originRef) return null;
  const onOrigin = store.agents.listAgents().filter((a) => store.tasks.getTask(a.taskId)?.originRef === originRef);
  const previous = onOrigin[0];
  if (!previous || previous.status !== 'done' || !previous.sessionId) return null;
  if (onOrigin.filter((a) => a.sessionId === previous.sessionId).length > 1) return null;
  return { previous, priorAttempts: onOrigin.length };
}

export function retryNote(attempt: number, worktreeRecreated: boolean): string {
  const worktree = worktreeRecreated
    ? '\n- **Your worktree was removed when your last turn ended, and has been recreated from the branch.** ' +
      'Anything you committed is in it; anything you left uncommitted is gone. Do not assume a file you ' +
      'remember editing still holds that edit — read it back before you build on it.'
    : '';
  return (
    `## You have worked this before — this is attempt ${attempt}\n\n` +
    'Everything already in this conversation is your own earlier work on this same concern. ' +
    'Your last turn on it ended without the concern being cleared, so the harness has re-opened ' +
    'this conversation rather than starting you cold. Use what you worked out; do not pay for it twice.\n\n' +
    'Two things are not as you left them:\n\n' +
    '- The concern is restated below **as the world reports it now**, which may have moved since you ' +
    'last looked. Where your memory and the restatement disagree, the restatement is the current truth.' +
    `${worktree}\n\n` +
    'What did not work last time is unlikely to work unchanged. Before repeating an approach you have ' +
    'already tried, say what you are doing differently and why.'
  );
}
