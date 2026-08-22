import { CONTRADICTION_RULE, validateContradiction } from '../../knowledge/knowledge.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * Say that a claim the fleet handed this agent is contradicted by the code in
 * front of it — **and say what it should say instead**.
 *
 * This is the half `lessons` never had. Staleness there rested on an agent
 * mentioning it in a retrospective and a human noticing, which is why the lesson
 * block's header had to ask for it in prose; here the agent that finds the edge
 * has somewhere to put it, in the turn it found it.
 *
 * **The amendment is the whole call, and a contradiction without one is refused.**
 * A count of objections punishes exactly the wrong claims: one that is right in
 * general and wrong at one edge attracts contradictions *because it is being
 * used*, so the most valuable claims in the store are the first a count would
 * kill. The real example this was drawn against is "drop the `export` keyword
 * rather than delete it" — true of a type or a helper, false of a class member,
 * where knip's analysis is name-based. Three agents hitting that edge should
 * sharpen the claim; under a count they delete it.
 *
 * **Nothing this call does demotes the claim.** It is filed, it is counted, and it
 * is put in front of an operator — and until one rules, the claim goes on riding
 * every prompt it was riding before. The response says so, because an agent that
 * believes it has just taken a stale claim off the fleet stops looking at it.
 */
export const knowledgeContradict: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say that a claim the harness gave you — in your system prompt, in your task prompt, or from ' +
    'knowledge_ask — is contradicted by the repository in front of you. The code is the authority; a ' +
    'claim it disagrees with is stale, and you are the only one in a position to notice.\n\n' +
    `**${CONTRADICTION_RULE}**\n\n` +
    'Most claims worth disputing are not simply wrong: they are right in general and wrong at the edge ' +
    'you just hit. Write the amendment that keeps what still holds and covers what you saw — that is ' +
    'the version the next agent should have read.\n\n' +
    'It changes nothing on your say-so. The claim goes on reaching every agent it already reached, and ' +
    'your amendment sits as a proposal until a second goal sees the same thing or an operator rules. So ' +
    'file it and carry on with your own task — and go on working to what the code says, not to the ' +
    'claim you just disputed.\n\n' +
    'Not the place for: a claim that is simply new (knowledge_propose), something true only today ' +
    '(knowledge_notice), or a defect in the repository itself (report_finding).',
  inputSchema: {
    type: 'object',
    properties: {
      factId: {
        type: 'string',
        description:
          'The id of the claim you are disputing, exactly as you were given it. Every claim in your ' +
          'prompts and every answer from knowledge_ask carries one.',
      },
      amendment: {
        type: 'string',
        description:
          'What the claim should say instead, written as a claim in its own right — not a note about ' +
          'the old one. It is filed as a proposal naming the original, and if it is adopted it is what ' +
          'every agent reads next, so it has to stand on its own without the sentence it replaces.',
      },
      evidence: {
        type: 'string',
        description:
          'What you actually saw that the claim does not fit: the file, the command, the output. This ' +
          'is what an operator reads to choose between the claim and your amendment, so it is your own ' +
          'observation rather than a restatement of either.',
      },
    },
    required: ['factId', 'amendment', 'evidence'],
  },
  handler: (args) => {
    const parsed = validateContradiction(args);
    if (!parsed.ok) return toolError(`Contradiction rejected: ${parsed.error}`);
    const result = deps.agents.contradictFact(agent.id, parsed.contradiction);
    if (!result.ok) return toolError(result.error);
    const outcome = result.outcome;
    if (outcome.outcome === 'unknown') {
      return toolError(
        `No claim with id "${parsed.contradiction.factId}" is on record. Use the id exactly as it was ` +
          `given to you; if what you have is a sentence rather than an id, ask for it with knowledge_ask.`,
      );
    }
    // Refused by name and with the reason, `knowledge_propose`'s rule: a silent
    // refusal leaves an agent believing the fleet has been told something it has
    // not, which is worse here than anywhere else in this store — the belief is
    // that a stale claim has been dealt with.
    if (outcome.outcome === 'refused') return toolError(`Contradiction rejected: ${outcome.error}`);
    const { fact, amendment, contradictions } = outcome;
    return ok({
      recorded: true,
      contradicted: { id: fact.id, reach: fact.reach },
      amendment: { id: amendment.id, scope: amendment.scope, reach: amendment.reach },
      contradictions,
      note:
        `Recorded, and your amendment is filed as a claim of its own naming ${fact.id}. ` +
        `**The claim you disputed has not moved**: it is still ${fact.reach}, still reaching every agent ` +
        `it reached before, and nothing but an operator or its own clock will change that — a claim is ` +
        `never demoted by a count of objections. ${
          amendment.reach === 'proposal'
            ? 'Your amendment reaches nobody yet; a second goal seeing the same edge, or an operator, is what carries it.'
            : `Your amendment is already at ${amendment.reach}: somebody else had written the same sharper claim.`
        } Work to what the repository says, and carry on with your own task.`,
    });
  },
});
