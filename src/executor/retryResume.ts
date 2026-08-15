import type { Store } from '../store/store.js';
import type { Agent } from '../types.js';

/**
 * Which conversation a re-dispatch should re-attach to, and the note the agent
 * that inherits it is handed (issue #333).
 *
 * `DEFAULT_COOLDOWN` allows three attempts per origin and every one of them used
 * to be a brand-new session: a fresh id at every spawn, so attempt two re-read the
 * repository and `CLAUDE.md` to re-derive what attempt one had already worked out,
 * and then walked the same path because nothing told it the path had been walked.
 * The cooldown stops a *loop*; it never stopped a *repeat*.
 *
 * The decision lives in the executor rather than in `dispatchVerdict` for two
 * reasons. The verdict is pure over the audit log by design, and "does this origin
 * have a resumable dead agent" is a store lookup it cannot make without widening
 * its signature. And it counts `update_pr_branch` as an attempt (issue #332),
 * which has no agent at all — so a fourth `resume` verdict would be conditional on
 * things the pure function cannot see. The executor is already where every
 * dispatch passes and where the prompt's appended notes are assembled.
 */

/** The previous agent whose conversation a retry inherits, and what to tell it. */
export interface RetryResume {
  /** The ended agent whose `sessionId` the new launch will `--resume`. */
  previous: Agent;
  /**
   * How many agents this origin has already spent, so the note can say which
   * attempt this is without the executor re-deriving it from the audit log.
   */
  priorAttempts: number;
}

/**
 * The conversation a re-dispatch of `originRef` should continue, or null when this
 * dispatch starts cold.
 *
 * **Only a `done` agent qualifies, and that is narrower than it looks by
 * accident.** `done` is precisely the population the cooldown was written for — a
 * code agent that finishes without clearing its concern (#35, #36) — and every
 * other ending already has an owner that a re-attach would race or override:
 *
 * - `starting` / `running` / `waiting` are *live*. A concern reaching a live agent
 *   is `respond_to_agent` down the branch-notify path, and must stay so; resuming
 *   would put two processes on one conversation.
 * - `crashed` means a recovery verdict is outstanding, and the desk offers
 *   restore/requeue/remove over a wider choice than "carry on".
 * - `killed` and `interrupted` are *decided* endings — an operator or the recovery
 *   desk chose them. Resurrecting a decided ending is exactly what `autoResume`
 *   refuses to do, for the same reason.
 * - `failed` has just spent its `resumeAttempts` budget crashing. `autoResume`
 *   already re-attached to that conversation as many times as it is allowed to;
 *   handing it to a fresh dispatch asks for the crash again, which is why this is
 *   a deliberate exclusion rather than a conservative one.
 *
 * **A conversation is inherited at most once.** Stated as a property of the
 * transcript rather than as an attempt number, so it needs no view of the cooldown
 * policy and holds however the operator sets `maxAttempts`: the first attempt mints
 * the id, the second inherits it, and a third finds two rows already carrying it
 * and goes cold. That is the "the last attempt should be deliberately cold" hedge
 * — a conversation that has failed twice may be worse than a clean one, not better
 * — and under the default three attempts it lands exactly on the final one.
 */
export function retryResumeFor(originRef: string | null | undefined, store: Store): RetryResume | null {
  if (!originRef) return null;
  // `listAgents` is newest-first, so the first match is the last agent to work this
  // origin — the only one whose conversation is worth continuing.
  const onOrigin = store.listAgents().filter((a) => store.getTask(a.taskId)?.originRef === originRef);
  const previous = onOrigin[0];
  if (!previous || previous.status !== 'done' || !previous.sessionId) return null;
  // Two rows carrying one id means the conversation has already been inherited.
  if (onOrigin.filter((a) => a.sessionId === previous.sessionId).length > 1) return null;
  return { previous, priorAttempts: onOrigin.length };
}

/**
 * What the agent inheriting the conversation is told, as its own block at the head
 * of the re-dispatch prompt.
 *
 * **Not `buildResumeMessage`'s "you were resumed after a server restart".** Nothing
 * restarted, and an agent that believes otherwise re-reads its branch looking for
 * work it did itself minutes ago — the same lie `LIMIT_RESUME_MESSAGE` exists to
 * avoid on the usage-limit park, which is the closest existing path and reads the
 * way this one should.
 *
 * **It goes first, ahead of the restated concern, and it is still a separate block
 * rather than anything filled into the template.** The agent has to know it is
 * looking at ground it has covered *before* it reads the restatement, or the
 * restatement is just a second task; and prompt templates are operator-overridable,
 * so a `{retry}` placeholder would be dropped silently by any override that never
 * learned about it.
 *
 * `worktreeRecreated` is the code-agent case and is not a detail: a cleanly
 * finished agent's worktree is removed when it is reaped and recreated from the
 * branch by the next `ensure`, so the conversation remembers edits that a
 * `--force` removal discarded. An agent that trusts that memory reports work it
 * cannot see and is not there.
 */
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
