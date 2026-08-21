import { corroborationGoal, SCOPE_HELP, validateFactProposal } from '../../knowledge/knowledge.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * File one thing this agent learned about working the repository that the
 * repository itself does not say.
 *
 * **Who may call it is the widening this whole subsystem is worth having for.**
 * Before it, only a retrospective — and a remedy under one of four guard verdicts
 * — could write a durable claim down, so a planner, an assayer, a validator and an
 * issue-work agent could learn something the hard way and had nowhere to put it
 * but prose nobody reads. Proposals cost nothing until somebody vouches, so
 * widening who may propose costs nothing either; the gate in front of what reaches
 * other agents is unchanged.
 *
 * **The second caller of this tool is as important as the first.** An agent that
 * runs into a wall somebody has already written down calls this with the same
 * words it would have used anyway, and the claim is recorded as its corroboration
 * rather than as a second copy — which is what carries a claim out of one agent's
 * head without an operator having to read every proposal.
 */
export const knowledgePropose: ToolFactory = ({ deps, agent, task, ok }) => {
  // Read once, here, so an agent with no goal behind it is not offered a scope it
  // would be refused for using.
  const goalRef = corroborationGoal(task.originRef);
  const scopes = goalRef ? ['fleet', 'goal', 'check:<name>'] : ['fleet', 'check:<name>'];
  return {
    description:
      'Write down something you learned about working THIS REPOSITORY that the repository does not ' +
      'say — the paragraph you would have wanted to read before you started. A seam, an invariant, a ' +
      'second place a thing must be registered, a check that fails for a reason its output does not ' +
      'give.\n\n' +
      'Call it when you learn it, not at the end: the value is that the next agent does not pay for ' +
      'it again, and a claim you were going to mention in a write-up reaches nobody.\n\n' +
      'It reaches no other agent on your say-so. A claim needs two goals behind it before it can even ' +
      'be looked up, and an operator before it goes in front of every agent — so propose it plainly ' +
      'and carry on with your own task. **If somebody has already filed this claim, your call is ' +
      'recorded as corroboration rather than as a second copy, and that is the most useful call you ' +
      'can make here**: it is the difference between one agent believing something and the fleet ' +
      'knowing it.\n\n' +
      'This is not the place for: a defect (report_finding), what you are doing right now ' +
      '(note_progress), or a note to the other agents on your own goal (scratch_append). And it is ' +
      'not the place for a fact about the CODE — that belongs in the repository, which is where a ' +
      'committed fact ends up.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description:
            'The claim itself, in the words you would want to read it in — a line or two. State what ' +
            'is true, not what to do about it: "knip runs every rule at error, so an unimported ' +
            'export fails check" is a claim an agent can weigh against the code in front of it.',
        },
        scope: {
          type: 'string',
          description: `Who this is true for. One of: ${scopes.join(', ')}. ${Object.values(SCOPE_HELP).join('. ')}`,
        },
        evidence: {
          type: 'string',
          description:
            'What you actually saw that makes it true: the command, the error, the file you found it ' +
            'in. This is what an operator reads to decide whether the claim should reach other ' +
            'agents, and — if you are agreeing with a claim somebody else filed — it is your own ' +
            'observation, not a restatement of theirs.',
        },
        lifetime: {
          type: 'string',
          enum: ['standing', 'expiring'],
          description:
            'standing (the default): true until somebody retires it. expiring: what you saw is true ' +
            'today and will stop being true — a check that has been timing out all afternoon. Say ' +
            'expiring rather than dressing a passing condition up as a permanent fact.',
        },
        expiresInHours: {
          type: 'number',
          description: 'Required with lifetime "expiring": how long you expect what you saw to still be true.',
        },
        supersedes: {
          type: 'string',
          description:
            'The id of a fact this one amends, if you are sharpening one you were shown. An ' +
            'amendment is filed as its own claim rather than folded into its parent — including when ' +
            'the parent was rejected, which is the only way a rejected claim comes back.',
        },
      },
      required: ['claim', 'scope', 'evidence'],
    },
    handler: (args) => {
      // Validated at the boundary with the reason handed back: a malformed claim is
      // a fixable error in this turn rather than a row an operator has to read to
      // find out what it was meant to say.
      const parsed = validateFactProposal(args, goalRef);
      if (!parsed.ok) return toolError(`Proposal rejected: ${parsed.error}`);
      const result = deps.agents.proposeFact(agent.id, parsed.proposal);
      if (!result.ok) return toolError(result.error);
      const outcome = result.outcome;
      if (outcome.outcome === 'barred') {
        // Refused by name, with the way back. A silent refusal teaches the fleet
        // nothing and it files the same claim again tomorrow — and the amendment
        // arm is the one thing that would actually change the operator's mind.
        return toolError(
          `An operator has rejected this claim, so it cannot be filed again: "${outcome.barredBy.claim}" ` +
            `(${outcome.barredBy.id}). Rejected means it was judged not true. If what you saw genuinely ` +
            `differs from that claim, file the sharper version with supersedes: "${outcome.barredBy.id}" — ` +
            `an amendment is exempt from its parent's bar. Otherwise take the rejection as the answer.`,
        );
      }
      const { fact, corroborations } = outcome;
      return ok({
        recorded: true,
        fact: { id: fact.id, scope: fact.scope, lifetime: fact.lifetime, reach: fact.reach },
        corroborations,
        // Said in the response and not only in the description, `report_finding`'s
        // rule: an agent that believes its claim is now in front of the fleet has
        // been told something untrue about what it just did.
        note:
          outcome.outcome === 'filed'
            ? 'Filed as a proposal. It reaches no other agent yet — a second goal seeing the same thing, ' +
              'or an operator, is what carries it further. Keep going with your own task.'
            : `Recorded as corroboration on the standing claim — ${corroborations} independent ` +
              `${corroborations === 1 ? 'goal has' : 'goals have'} now seen it. Nothing else is needed from you.`,
      });
    },
  };
};
