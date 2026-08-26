import {
  corroborationGoal,
  NOTICE_RULE,
  SCOPE_HELP,
  validateRaise,
  validateRaisedAgreement,
  validateRaisedContradiction,
} from '../../knowledge/knowledge.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The one door: anything an agent learns that the harness should know.
 *
 * **What this replaces is a question the agent was never in a position to
 * answer.** Filing an observation used to mean choosing between `report_finding`
 * (and then which of its four kinds), `knowledge_propose`, `knowledge_notice`,
 * `knowledge_contradict` and a retrospective's `lessons` field — six doors sorted
 * by *what an operator would do about it*, which is knowledge the operator has and
 * the agent does not. The discriminator was stated in three places precisely
 * because it did not stick, and each restatement was a place it could drift.
 *
 * So the axis is inverted. The agent says what it saw; **where the claim goes is
 * the harness's to work out and the operator's to settle**. Nothing here asks for
 * a kind, a lifetime word or a destination:
 *
 * - `contradicts` present → the claim is an amendment, and the dispute is recorded
 * - `agreeWith` present → the call is a corroboration of the claim it names
 * - `until` present → the claim is a notice, bounded by that clock
 * - otherwise → a standing claim, scoped `fleet` unless the agent says otherwise
 *
 * **The gate is untouched, which is what makes the widening free.** A raised claim
 * reaches nobody on its author's say-so: two goals agreeing carries it as far as
 * lookup, an operator carries it further, and nothing in the dispatcher reads it
 * at any reach. Making it easier to file costs nothing because filing has never
 * been what puts a sentence in front of the fleet.
 */
export const raise: ToolFactory = ({ deps, agent, task, ok }) => {
  // Read once, here, so an agent with no goal behind it is not offered a scope it
  // would be refused for using — the proposal intake's rule, kept.
  const goalRef = corroborationGoal(task.originRef);
  const scopes = goalRef ? ['fleet', 'goal', 'check:<name>'] : ['fleet', 'check:<name>'];
  return {
    description:
      'Raise something you learned that the next agent should not have to learn again. One tool for all ' +
      'of it: a seam or an invariant this repository does not document, a check that fails for a reason ' +
      'its output does not give, a duplicate you spotted, an unrelated defect you had to work around, ' +
      'something true only today.\n\n' +
      'Call it the moment you learn it, not at the end — a claim you were going to mention in a write-up ' +
      'reaches nobody, and a write-up may summarise it away.\n\n' +
      '**You do not have to work out what kind of thing it is, or what should happen about it.** Say what ' +
      'is true and what you saw; the harness works out where it goes and an operator decides what it is ' +
      'for. If somebody has already raised the same claim, your call is recorded as agreeing with it ' +
      'rather than as a second copy — and that is the most useful call you can make here, because it is ' +
      'the difference between one agent believing something and the fleet knowing it.\n\n' +
      'It reaches no other agent on your say-so, and it queues no work and dispatches nobody. Raise it ' +
      'and carry straight on with your own task rather than going to act on it.\n\n' +
      'Not the place for: what you are doing right now (note_progress), a note to the other agents on ' +
      'your own goal (scratch_append), or something you need answered before you can continue ' +
      '(escalate — this parks nobody and is not a way to wait).',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description:
            'What is true, in the words you would want to read it in — a line or two. State the thing, ' +
            'not what to do about it: "knip runs every rule at error, so an unimported export fails ' +
            'check" is something the next agent can weigh against the code in front of it. Write it for ' +
            'whoever reads it next month rather than for whoever is reading your own task: the harness ' +
            'knows your goal from your credential, and takes any mention of it back out into the evidence. ' +
            NOTICE_RULE,
        },
        evidence: {
          type: 'string',
          description:
            'What you actually saw that makes it true: the command, the error, the file you found it in. ' +
            'This is what an operator reads to decide whether it should reach other agents — and if you ' +
            'are agreeing with a claim somebody else raised, it is your own observation, not a ' +
            'restatement of theirs.',
        },
        where: {
          type: 'string',
          description:
            'What locates it, if anything does: a file and line, a package, a service, an endpoint. ' +
            'Optional — leave it out rather than writing "N/A".',
        },
        ref: {
          type: 'string',
          description:
            'The issue or pull request this is ABOUT, as "issue:41" or "pr:412", when it is about one — ' +
            'a duplicate, a defect in work somebody else has open. Not the thing you are working on: ' +
            'the harness already knows that from your credential.',
        },
        until: {
          type: 'number',
          description:
            'Only if what you saw will STOP being true: how many hours you expect it to last. A check ' +
            'that has been timing out all afternoon, a registry refusing installs. Leave it out for ' +
            'anything that will still be true next month — most claims. What you raise with a clock on ' +
            'it can reach every agent on agreement alone, which is safe only because it ends by itself.',
        },
        agreeWith: {
          type: 'string',
          description:
            'The id of a claim you were shown that you have now seen for yourself. Every claim in your ' +
            'prompt and every answer from knowledge_ask carries one. Use it when what you saw is what the ' +
            'claim already says — this is the most useful call you can make here, because two goals seeing ' +
            "one thing is what carries a claim out of one agent's head. Your evidence is your own " +
            'observation, not a restatement of theirs. Cannot be combined with contradicts.',
        },
        contradicts: {
          type: 'string',
          description:
            'The id of a claim you were shown that the code in front of you contradicts. Every claim in ' +
            'your prompt and every answer from knowledge_ask carries one. Your claim is then what it ' +
            'should say INSTEAD — a bare objection is refused, because a claim that is right in general ' +
            'and wrong at one edge is worth sharpening rather than deleting. It moves nothing on your ' +
            'say-so: the original goes on reaching agents until an operator rules, and you go on working ' +
            'to what the code says.',
        },
        scope: {
          type: 'string',
          description:
            `Who it is true for, if you know. Defaults to fleet. One of: ${scopes.join(', ')}. ` +
            `${Object.values(SCOPE_HELP).join('. ')}`,
        },
      },
      required: ['claim', 'evidence'],
    },
    handler: (args) => {
      const fields = (args ?? {}) as Record<string, unknown>;
      // Agreement first, because it is the one arm that files nothing: an agent
      // that named a claim it agrees with has said what the matcher would
      // otherwise have had to guess, and there is no proposal here to validate.
      if (typeof fields.agreeWith === 'string' && fields.agreeWith.trim()) {
        const parsed = validateRaisedAgreement(args);
        if (!parsed.ok) return toolError(`Not raised: ${parsed.error}`);
        const result = deps.agents.agreeWithFact(agent.id, parsed.agreement.factId, parsed.agreement.evidence);
        if (!result.ok) return toolError(result.error);
        const outcome = result.outcome;
        if (outcome.outcome === 'unknown') {
          return toolError(
            `No claim has that id (${parsed.agreement.factId}). Agree with a claim you were actually shown — ` +
              `every one in your prompt and every answer from knowledge_ask carries its id. If what you have is ` +
              `a sentence rather than an id, raise it as its own claim and the harness will match it.`,
          );
        }
        if (outcome.outcome === 'refused') return toolError(`Not raised: ${outcome.error}`);
        const { fact, corroborations } = outcome;
        return ok({
          recorded: true,
          agreedWith: { id: fact.id, claim: fact.claim, reach: fact.reach },
          corroborations,
          note:
            `Recorded as agreeing, with your own observation beside it — ${corroborations} independent ` +
            `${corroborations === 1 ? 'goal has' : 'goals have'} now seen it. Two *different* goals are what ` +
            `carry a claim as far as lookup, so agreeing with something you raised yourself moves nothing. ` +
            `Nothing else is needed from you.`,
        });
      }
      const disputes = typeof fields.contradicts === 'string';
      // The routing, and the whole of it. Which arm this is was decided by whether
      // the agent named a claim it disputes — never by a word it had to pick.
      if (disputes) {
        const parsed = validateRaisedContradiction(args);
        if (!parsed.ok) return toolError(`Not raised: ${parsed.error}`);
        const result = deps.agents.contradictFact(agent.id, parsed.contradiction);
        if (!result.ok) return toolError(result.error);
        const outcome = result.outcome;
        // Both non-`recorded` arms come back as an error the agent can act on: an
        // id that names nothing is a typo it can fix this turn, and a refusal
        // carries its own reason. Neither is a success worth an envelope.
        if (outcome.outcome === 'unknown') {
          return toolError(
            `No claim has that id (${parsed.contradiction.factId}). Contradict a claim you were actually ` +
              `shown — every one in your prompt and every answer from knowledge_ask carries its id. If what ` +
              `you have is a sentence rather than an id, ask for it with knowledge_ask.`,
          );
        }
        if (outcome.outcome === 'refused') return toolError(`Not raised: ${outcome.error}`);
        const { fact, amendment, contradictions } = outcome;
        return ok({
          recorded: true,
          disputed: { id: fact.id, claim: fact.claim },
          amendment: { id: amendment.id, reach: amendment.reach },
          contradictions,
          note:
            'Recorded as a contradiction, with your claim filed as the amendment. Nothing moved: the ' +
            'claim you disputed goes on reaching agents until an operator rules on it. Work to what the ' +
            'code in front of you says.',
        });
      }
      const parsed = validateRaise(args, goalRef);
      if (!parsed.ok) return toolError(`Not raised: ${parsed.error}`);
      const result = deps.agents.proposeFact(agent.id, parsed.proposal);
      if (!result.ok) return toolError(result.error);
      const outcome = result.outcome;
      if (outcome.outcome === 'barred') {
        // Refused by name, with the way back — the proposal intake's rule, and its
        // reason: a silent refusal teaches the fleet nothing and it raises the same
        // claim again tomorrow.
        return toolError(
          `An operator has rejected this claim, so it cannot be raised again: "${outcome.barredBy.claim}" ` +
            `(${outcome.barredBy.id}). Rejected means it was judged not true. If what you saw genuinely ` +
            `differs from that claim, raise the sharper version with contradicts: "${outcome.barredBy.id}" — ` +
            `an amendment is exempt from its parent's bar. Otherwise take the rejection as the answer.`,
        );
      }
      const { fact, corroborations } = outcome;
      return ok({
        recorded: true,
        fact: { id: fact.id, scope: fact.scope, lifetime: fact.lifetime, reach: fact.reach },
        corroborations,
        // Said, never done quietly. An agent told nothing files the same shape
        // tomorrow, and a rewrite nobody was told about is a second thing to be
        // wrong about silently — so the result carries the claim as stored and why
        // it differs from what was sent.
        ...(parsed.framing.removed !== null && {
          reframed: {
            removed: parsed.framing.removed,
            claim: fact.claim,
            why:
              `Your own task (${parsed.framing.removed}) was taken out of the claim and your original wording ` +
              `kept verbatim as the first line of the evidence. The harness resolves your goal from your ` +
              `credential, so a claim naming it is naming the one thing this store does not need told — and ` +
              `the ref is part of what the matcher compares, so nobody else's wording could ever have agreed ` +
              `with it. Nothing else was changed.`,
          },
        }),
        // Said in the response and not only in the description: an agent that
        // believes its claim is now in front of the fleet has been told something
        // untrue about what it just did, and will say it again, louder.
        note:
          outcome.outcome === 'filed'
            ? 'Raised. It reaches no other agent yet — a second goal seeing the same thing, or an ' +
              'operator, is what carries it further. Nothing is queued and nobody is dispatched: carry ' +
              'on with your own task.'
            : `Recorded as agreeing with a claim already raised — ${corroborations} independent ` +
              `${corroborations === 1 ? 'goal has' : 'goals have'} now seen it. Nothing else is needed from you.`,
      });
    },
  };
};
