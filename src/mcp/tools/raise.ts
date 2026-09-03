import { extractKeys, gateKeys } from '../../obstacles/keys.js';
import { buildObstacleWorld, reportedChecks } from '../../obstacles/world.js';
import { lookupFor, ownBreakage, validateRaisedObstacle } from '../../obstacles/intake.js';
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
 * The one door: anything in an agent's way that is not its goal, and anything true
 * of this repository that the repository does not say.
 *
 * **What this replaces is a question the agent was never in a position to answer.**
 * Filing an observation used to mean choosing between `report_finding` (and then
 * which of its four kinds), `knowledge_propose`, `knowledge_notice`,
 * `knowledge_contradict` and a retrospective's `lessons` field — six doors sorted
 * by *what an operator would do about it*, which is knowledge the operator has and
 * the agent does not. The intake collapsed those to one; the obstacle board
 * (`docs/spec/32-obstacles.md`) keeps the one door and reshapes what is asked
 * through it.
 *
 * The routing, and the whole of it — no kind, no lifetime word, no destination:
 *
 * - `agreeWith` present → the call is a corroboration of the claim it names
 * - `contradicts` present → the claim is an amendment, and the dispute is recorded
 * - `fix_makes_it_go_away` true → an **obstacle**, and the call is also the lookup
 * - otherwise → a **note**, which is a claim about the repository
 *
 * **Reporting is the lookup.** There is no search tool: an agent does not search on
 * a hunch, and searching would require it to guess the words somebody else used —
 * the failure `knowledge_ask` had. It calls something the moment it is in pain, so
 * the pain call returns the answer, in one round trip, with no model call and
 * nothing to wait for. The report is filed either way and never held pending a
 * reply.
 *
 * **The gate is untouched on both arms.** A claim reaches nobody on its author's
 * say-so, and an obstacle reaches nobody until a second independent voice has said
 * it. Making it easier to file costs nothing, because filing has never been what
 * puts a sentence in front of the fleet.
 */
export const raise: ToolFactory = ({ deps, agent, task, ok }) => {
  // Read once, here, so an agent with no goal behind it is not offered a scope it
  // would be refused for using — the proposal intake's rule, kept.
  const goalRef = corroborationGoal(task.originRef);
  const scopes = goalRef ? ['fleet', 'goal', 'check:<name>'] : ['fleet', 'check:<name>'];
  return {
    description:
      'Raise something that is in your way and is not your goal, or something true of this repository that ' +
      'the repository does not say. A check failing for reasons nothing to do with your change, a base branch ' +
      'somebody else broke, a bug in code nobody is touching, a seam this repository does not document.\n\n' +
      'Call it the moment you are in pain, not at the end. **The call is the lookup**: it answers with whether ' +
      'anybody else has hit this, who owns it if anyone does, and what they saw — in one round trip, with ' +
      'nothing to wait for. There is no search tool, because searching would mean guessing the words somebody ' +
      'else used.\n\n' +
      'You do not have to work out what kind of thing it is. Answer one question — would a fix make this go ' +
      'away? — and the harness works out the rest from what you wrote and the dispatch you are on.\n\n' +
      'It reaches no other agent on your say-so, it queues no work and it dispatches nobody. Raise it and ' +
      'carry straight on: do not go fixing what you just reported.\n\n' +
      'Not the place for: what you are doing right now (note_progress), a note to the other agents on your ' +
      'own goal (scratch_append), or something you need answered before you can continue (escalate — this ' +
      'parks nobody and is not a way to wait).',
    inputSchema: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          description:
            'One line, in your own words, saying what you hit. State the thing, not what to do about it. ' +
            'Write it for whoever reads it next month rather than for whoever is reading your own task: the ' +
            'harness knows your goal from your credential and takes any mention of it back out. ' +
            NOTICE_RULE,
        },
        why_not_mine: {
          type: 'string',
          description:
            'Why this is not your own change doing — and for something you are simply writing down, what you ' +
            'actually saw that makes it true: the command, the error, the file. Required, and nothing ' +
            'validates it: writing it down is what makes you check before you answer, and it is what an ' +
            'operator reads when the routing turns out wrong.',
        },
        fix_makes_it_go_away: {
          type: 'boolean',
          description:
            'True if a fix would end it — a red check, a wedged runner, a bug nobody is on. False if it is ' +
            'something true of this repository that a fix would not change, which ends by being written down ' +
            'rather than by being fixed. It is the only classification asked of you, and it is the only one ' +
            'you are in a position to make.',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional. What identifies it, as "check:<name>", "test:<file> > <name>", "path:<file>", ' +
            '"signature:<first line of the error>" or "cmd:<command>". Leave it out and the harness reads ' +
            'them out of what you wrote and the dispatch you are on. Anything that names nothing real is ' +
            'dropped and your report is kept — nothing here is ever refused for a key.',
        },
        blocks_me: {
          type: 'boolean',
          description:
            'True only if this stops you finishing the task you were dispatched for — the base will not ' +
            'build, the thing you must change is behind it. Not "it is annoying" and not "it made this ' +
            'slower": say true and you will be told to conclude `blocked`, which parks your goal until the ' +
            'obstacle clears rather than failing it. Everything else, carry on and work around it.',
        },
        until: {
          type: 'number',
          description:
            'Only if what you saw will STOP being true: how many hours you expect it to last. A check timing ' +
            'out all afternoon, a registry refusing installs. A backstop and never the mechanism — what ends ' +
            'it is the world clearing it or somebody fixing it.',
        },
        agreeWith: {
          type: 'string',
          description:
            'The id of a claim you were shown that you have now seen for yourself. Every claim in your ' +
            'prompt and every answer from knowledge_ask carries one. Use it when what you saw is what the ' +
            'claim already says — this is the most useful call you can make here, because two goals seeing ' +
            "one thing is what carries a claim out of one agent's head. Your account is your own " +
            'observation, not a restatement of theirs. Cannot be combined with contradicts.',
        },
        contradicts: {
          type: 'string',
          description:
            'The id of a claim you were shown that the code in front of you contradicts. Your line is then ' +
            'what it should say INSTEAD — a bare objection is refused, because a claim that is right in ' +
            'general and wrong at one edge is worth sharpening rather than deleting. It moves nothing on ' +
            'your say-so: the original goes on reaching agents until an operator rules.',
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
        scope: {
          type: 'string',
          description:
            `Who it is true for, if you know. Defaults to fleet. One of: ${scopes.join(', ')}. ` +
            `${Object.values(SCOPE_HELP).join('. ')}`,
        },
      },
      required: ['what', 'why_not_mine'],
    },
    handler: (args) => {
      const fields = (args ?? {}) as Record<string, unknown>;
      // The claim store's own validators are untouched and read the names they
      // always did: `docs/spec/27-knowledge.md` stays true and running until the
      // last of 32 lands, so the two fields the intake renamed are adapted at the
      // one place that knows both spellings rather than in `src/knowledge/`.
      const asClaim = { ...fields, claim: fields.what, evidence: fields.why_not_mine };
      // Agreement first, because it is the one arm that files nothing: an agent
      // that named a claim it agrees with has said what the matcher would
      // otherwise have had to guess, and there is no proposal here to validate.
      if (typeof fields.agreeWith === 'string' && fields.agreeWith.trim()) {
        const parsed = validateRaisedAgreement(asClaim);
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
        const parsed = validateRaisedContradiction(asClaim);
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
      // The one classification asked of the agent, and the whole of the routing:
      // *would a fix make this go away?* Anything else — including saying nothing —
      // is a note, which is a claim about the repository and goes where claims have
      // always gone.
      if (fields.fix_makes_it_go_away === true) {
        const raised = validateRaisedObstacle(args, goalRef);
        if (!raised.ok) return toolError(`Not raised: ${raised.error}`);
        const report = raised.report;
        const world = buildObstacleWorld({
          reported: reportedChecks(deps.store.getWorldBaseline()),
          dispatchChecks: task.ciChecks ?? [],
          branchPaths: goalRef === null ? [] : deps.store.listGoalFiles(goalRef).map((file) => file.path),
          repoRoot: deps.repoRoot ?? null,
        });
        const keys = gateKeys(
          extractKeys({ what: report.what, evidence: report.whyNotMine, world, declared: report.keys }),
          world,
        );
        // **An agent may not report its own breakage.** The harness holds the diff
        // already, so this is the only enforcement of *fix what you broke* that is
        // not a sentence in a prompt — and a sentence in a prompt is not an
        // enforcement. It refuses, names the file, and records nothing.
        const mine = ownBreakage(
          keys,
          deps.store.listFiles(agent.id).map((file) => file.path),
        );
        if (mine !== null) {
          return toolError(
            `Not raised: your own session wrote ${mine}, so this is yours to fix rather than to report. ` +
              `Nothing was recorded. If what you hit is genuinely elsewhere, raise it naming that instead — ` +
              `and if it is in your diff, fix it: an agent fixes what its own session broke.`,
          );
        }
        const outcome = deps.store.recordObstacleSighting(
          { what: report.what, kind: 'obstacle', keys, untilHours: report.untilHours },
          {
            agentId: agent.id,
            taskId: task.id,
            // The goal, never the origin and never the agent: `pr:412:ci` and
            // `pr:412:comments` are two origins of one observation, and the count of
            // independent voices is the whole of what carries a row to `standing`.
            goalRef,
            sessionId: agent.sessionId,
            transition: null,
            words: report.words,
            whyNotMine: report.whyNotMine,
          },
        );
        return ok({
          recorded: true,
          id: outcome.obstacle.id,
          ...lookupFor({
            obstacle: outcome.obstacle,
            voices: outcome.voices,
            sightings: deps.store.listObstacleSightings(outcome.obstacle.id),
            mine: outcome.sightingId,
            near: outcome.near,
            blocksMe: report.blocksMe,
          }),
        });
      }
      const parsed = validateRaise(asClaim, goalRef);
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
        // Near neighbours the strict matcher did not join, with the one sentence
        // that makes the answer actionable. **The claim is filed either way** — it
        // is never held pending a reply, because a round trip is a claim that may
        // not come back.
        ...(outcome.nearby.length > 0 && {
          nearMatches: outcome.nearby,
          couldAgree:
            'These claims already stand and look like yours, but not closely enough for the harness to ' +
            'record your call as agreeing with one. If any of them is what you meant, call raise again ' +
            'with agreeWith: "<id>" and your own observation — that is worth far more than a second copy. ' +
            'Your claim is filed either way; nothing is waiting on you.',
        }),
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
