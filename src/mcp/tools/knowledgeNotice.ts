import { corroborationGoal, NOTICE_RULE, SCOPE_HELP, validateFactNotice } from '../../knowledge/knowledge.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * Say what is true **today** and will stop being true — a check timing out all
 * afternoon, a registry refusing installs, a base branch that is red.
 *
 * **The one path in this design where agents put text in front of the whole fleet
 * with nobody in the loop.** A notice that a second goal has seen is injected into
 * every agent's system prompt on corroboration alone, where a standing claim needs
 * an operator. What makes that sane is not a judgement about agents: it is that a
 * notice ends by itself. Its blast radius is capped by its own clock, and the
 * clock is the whole of the safety argument — which is why this is a separate
 * tool from `knowledge_propose` rather than a flag on it. A clock an agent could
 * forget to ask for would be a standing fleet-wide claim filed by accident.
 *
 * The other half is {@link NOTICE_RULE}, said in the description and again on the
 * claim argument, because nothing downstream can check it: an observation that is
 * wrong is a wrong reading, and an instruction that is wrong is every agent for a
 * day being told to skip a check that is genuinely broken.
 *
 * **A notice reaches nobody until the moment it is injected**, which is what stops
 * its own delivery manufacturing its second voice: while it has one corroborator
 * it is a `proposal`, and a proposal is answered to no `knowledge_ask` and rides
 * no prompt. The second agent to say it cannot have read the first's.
 */
export const knowledgeNotice: ToolFactory = ({ deps, agent, task, ok }) => {
  const goalRef = corroborationGoal(task.originRef);
  const scopes = goalRef ? ['fleet', 'goal', 'check:<name>'] : ['fleet', 'check:<name>'];
  return {
    description:
      'Raise a short-lived observation about the state of things right now — something you saw that ' +
      'is true today and will stop being true. A check that has failed and then passed on the same ' +
      'commit, a registry that is refusing installs, a base branch that is red.\n\n' +
      `**${NOTICE_RULE}**\n\n` +
      'This is the one thing you can write that reaches every agent without an operator reading it ' +
      'first: a second agent on a different goal seeing the same thing puts it in front of the whole ' +
      'fleet. That is only safe because it expires — say how long you expect what you saw to still be ' +
      'true, and say it honestly. A week is the most anything here may run.\n\n' +
      'Not the place for: something that will still be true next month (knowledge_propose), a defect ' +
      '(report_finding), or what you are doing right now (note_progress).',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description:
            'What you saw, in one or two lines, as a statement about the world rather than about ' +
            `what to do. ${NOTICE_RULE} Write it without naming your own pull request or goal: an ` +
            'identical sighting from a second goal is what carries it to the fleet, and a sentence ' +
            'about your goal can never be matched by one about theirs.',
        },
        scope: {
          type: 'string',
          description: `Who this is true for. One of: ${scopes.join(', ')}. ${Object.values(SCOPE_HELP).join('. ')}`,
        },
        evidence: {
          type: 'string',
          description:
            'What you actually saw: the command, the job, the output, the times. This is what an ' +
            'operator reads to decide whether the notice should have gone to everyone, and it is ' +
            'your own observation rather than a restatement of the claim.',
        },
        expiresInHours: {
          type: 'number',
          description:
            'How long you expect what you saw to still be true. The notice is out of every prompt ' +
            'when it runs out, and nobody has to remember to withdraw it.',
        },
      },
      required: ['claim', 'scope', 'evidence', 'expiresInHours'],
    },
    handler: (args) => {
      const parsed = validateFactNotice(args, goalRef);
      if (!parsed.ok) return toolError(`Notice rejected: ${parsed.error}`);
      const result = deps.agents.proposeFact(agent.id, parsed.proposal);
      if (!result.ok) return toolError(result.error);
      const outcome = result.outcome;
      if (outcome.outcome === 'barred') {
        return toolError(
          `An operator has rejected this claim, so it cannot be raised again: "${outcome.barredBy.claim}" ` +
            `(${outcome.barredBy.id}). Rejected means it was judged not true. If what you saw genuinely ` +
            `differs, file the sharper version through knowledge_propose with supersedes: ` +
            `"${outcome.barredBy.id}". Otherwise take the rejection as the answer.`,
        );
      }
      const { fact, corroborations } = outcome;
      return ok({
        recorded: true,
        fact: { id: fact.id, scope: fact.scope, reach: fact.reach, lapsesAt: fact.expiresAt },
        corroborations,
        // Said in the response, `report_finding`'s rule: an agent that believes it
        // has just told the fleet something, when it has not, has been told
        // something untrue about what it just did — and the reverse matters more
        // here than anywhere else in this store, because this is the one call that
        // really can reach every agent.
        note:
          fact.reach === 'injected'
            ? `A second goal has now seen this, so it is in every agent's system prompt until it lapses ` +
              `(${fact.expiresAt}). Nothing else is needed from you.`
            : 'Raised. It reaches no other agent yet — a second goal seeing the same thing is what puts ' +
              'it in front of the fleet, and until then it sits where nobody reads it. Carry on with ' +
              'your own task.',
      });
    },
  };
};
