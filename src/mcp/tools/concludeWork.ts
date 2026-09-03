import { BLOCKED_STATUS, CONCLUSION_STATUSES, CONCLUSION_VERDICT_HELP, validateConclusion } from '../conclusion.js';
import { toolError } from '../protocol.js';
import { DONE_REMINDER } from '../../agents/agentProtocol.js';
import type { ToolFactory } from './context.js';

export const concludeWork: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say whether the ISSUE you were dispatched for is now finished — not whether your own turn is ' +
    'over. Call it once, at the end of your work, before you finish. This is the only thing that ' +
    'tells the harness a ticket is concluded: a tracker state like "In Review" does not distinguish ' +
    '"waiting on test" from "still has work in it", so if you say nothing the harness parks the ' +
    'ticket and waits for a human rather than guessing. Say "done" only if everything the issue ' +
    'asked for is delivered; say "more_work" if you did part of it or found more is needed, and the ' +
    'issue will come back round with your note in front of the next agent. Say "blocked", naming the ' +
    'obstacle you raised, if you could not finish because of something that is not this goal at all — the ' +
    'goal parks until that clears rather than coming back round for the next agent to hit the same wall.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...CONCLUSION_STATUSES],
        description: CONCLUSION_STATUSES.map((v) => `${v}: ${CONCLUSION_VERDICT_HELP[v]}`).join('. '),
      },
      obstacle: {
        type: 'string',
        description:
          'Required for blocked, ignored otherwise: the id of the obstacle that stopped you, as raise ' +
          'answered it. The goal is parked while that obstacle stands and comes back on its own when it ' +
          'clears — so this is what makes blocked a park rather than a dead end.',
      },
      note: {
        type: 'string',
        description:
          'What you delivered, or what is still outstanding and why. An operator decides what happens ' +
          'to the ticket from this alone, and for more_work the next agent reads it as their starting ' +
          'point — so be specific about what is left, not about what you did.',
      },
    },
    required: ['status', 'note'],
  },
  handler: (args) => {
    const parsed = validateConclusion(args);
    if (!parsed.ok) return toolError(`Conclusion rejected: ${parsed.error}`);
    // Its own path because it is its own record: a block writes no conclusion row
    // at all. The two verdicts below say something about the *work*; this says the
    // work could not be attempted, and the thing that lifts it is the board rather
    // than anybody's opinion about whether the goal is finished.
    if (parsed.verdict === BLOCKED_STATUS) {
      const blocked = deps.agents.recordBlocked(agent.id, parsed.obstacleId, parsed.note);
      if (!blocked.ok) return toolError(blocked.error);
      return ok({
        concluded: true,
        issue: blocked.block.originRef,
        status: BLOCKED_STATUS,
        note:
          `Recorded. ${blocked.block.originRef} is parked behind ${blocked.block.obstacleId} and nothing ` +
          `further will be dispatched for it until that obstacle stops reaching agents — then it comes back ` +
          `on its own, with no one having to remember it. Stop here: do not go fixing the obstacle. ` +
          DONE_REMINDER,
      });
    }
    // Structural identity, and here it carries more than attribution: the
    // origin decides whether there is anything to conclude at all. A part
    // agent is refused rather than scoped down — see `conclusionOrigin`.
    const result = deps.agents.recordConclusion(agent.id, parsed.verdict, parsed.note);
    if (!result.ok) return toolError(result.error);
    return ok({
      concluded: true,
      issue: result.conclusion.originRef,
      status: result.conclusion.verdict,
      // Said in the response as well as the description: an agent that
      // believes "done" closed the ticket would stop looking at it, and an
      // agent that believes "more_work" scheduled something would wait. The
      // finish reminder rides along for {@link DONE_REMINDER}'s reason.
      note:
        (parsed.verdict === 'done'
          ? 'Recorded. The harness will schedule nothing further for this issue. It does not close the ' +
            'ticket in the tracker — that stays a human decision.'
          : 'Recorded. The issue returns to pickup once its pull request is out of review, and your note ' +
            'goes to whoever picks it up. Nothing is dispatched right now.') +
        ' ' +
        DONE_REMINDER,
    });
  },
});
