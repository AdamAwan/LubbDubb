import { z } from 'zod';
import { BLOCKED_STATUS, CONCLUSION_STATUSES, CONCLUSION_VERDICT_HELP, validateConclusion } from '../conclusion.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import { DONE_REMINDER } from '../../agents/agentProtocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const concludeWork: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say whether the ISSUE you were dispatched for is now finished — not whether your own turn is ' +
    'over. Call it once, at the end of your work, before you finish. This is the only thing that ' +
    'tells the harness a ticket is concluded: a tracker state like "In Review" does not distinguish ' +
    '"waiting on test" from "still has work in it", so if you say nothing the harness parks the ' +
    'ticket and waits for a human rather than guessing. Say "done" only if everything the issue ' +
    'asked for is delivered; say "more_work" if you did part of it or found more is needed, and the ' +
    'issue will come back round with your note in front of the next agent. Say "blocked", with the reason, if ' +
    'you could not finish because of something that is not this goal at all — a base branch somebody else ' +
    'broke, a service that is down, a defect in code nobody is touching. The goal parks and the operator is ' +
    'asked to release it, rather than it coming back round for the next agent to hit the same wall. This is ' +
    'the one way to say you are stuck on something that is not yours: do not go fixing it.',
  inputSchema: toolSchema(
    z.object({
      status: z
        .enum(CONCLUSION_STATUSES)
        .describe(CONCLUSION_STATUSES.map((v) => `${v}: ${CONCLUSION_VERDICT_HELP[v]}`).join('. ')),
      reason: z
        .string()
        .describe(
          'Required for blocked, ignored otherwise: what stopped you, in your own words — the check, the ' +
            'branch, the error, the service. The operator reads it to decide when to release the goal, and ' +
            'the next agent reads it once they have.',
        )
        .optional(),
      note: z
        .string()
        .describe(
          'What you delivered, or what is still outstanding and why. An operator decides what happens ' +
            'to the ticket from this alone, and for more_work the next agent reads it as their starting ' +
            'point — so be specific about what is left, not about what you did.',
        ),
    }),
  ),
  handler: (args) => {
    const parsed = validateConclusion(args);
    if (!parsed.ok) return toolError(`Conclusion rejected: ${parsed.error}`);
    if (parsed.verdict === BLOCKED_STATUS) {
      const blocked = deps.agents.recordBlocked(agent.id, parsed.reason, parsed.note);
      if (!blocked.ok) return toolError(blocked.error);
      return ok({
        concluded: true,
        issue: blocked.block.originRef,
        status: BLOCKED_STATUS,
        note:
          `Recorded. ${blocked.block.originRef} is parked and the operator has been asked to release it; ` +
          `nothing further is dispatched for it until they do, and your reason goes to whoever picks it up ` +
          `after. Stop here: do not go fixing what stopped you. ` +
          DONE_REMINDER,
      });
    }
    const result = deps.agents.recordConclusion(agent.id, parsed.verdict, parsed.note);
    if (!result.ok) return toolError(result.error);
    return ok({
      concluded: true,
      issue: result.conclusion.originRef,
      status: result.conclusion.verdict,
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
