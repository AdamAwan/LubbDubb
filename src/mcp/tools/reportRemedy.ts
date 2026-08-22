import {
  CAUSES_BY_KIND,
  CAUSE_COPY,
  GUARD_COPY,
  GUARD_ORDER,
  remedyOrigin,
  validateRemedy,
} from '../../remedies/remedies.js';
import type { FactProposalOutcome } from '../../store/knowledge.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * Account for one return to a pull request: why it was red, or why a reviewer
 * asked for changes, and what settled it.
 *
 * **The kind decides the schema, and the kind comes from the origin.** A CI agent
 * is offered the CI causes and a review agent the review ones, because a taxonomy
 * with fourteen entries in front of a choice that has eight is a taxonomy where
 * everything lands on `other`. Building the schema from the caller's own origin —
 * rather than taking a `kind` argument and validating it — is what makes that
 * narrowing structural rather than a hope about how the description reads.
 *
 * **Every option carries its blurb into the schema**, in the words the panel uses.
 * The `pr-ci-fix` and `pr-review-comment` templates are operator-overridable, so a
 * deployment on an override written before this existed dispatches an agent that
 * hears about this tool from nowhere else. A tool description always arrives —
 * `retro_submit`'s reason for putting its discriminator here exactly.
 *
 * An agent whose origin is neither is refused by name and pointed at the tool it
 * actually wants; nothing about the refusal is a fault, and nothing is held on a
 * remedy that never arrives.
 */
export const reportRemedy: ToolFactory = ({ deps, agent, task, ok }) => {
  // The origin is read once, here, so a caller that may not file one is offered a
  // schema that says so rather than a menu it will be refused for using. `ci` is
  // the fallback shape for the refused caller: the handler rejects it before the
  // schema is ever consulted, and an empty enum is not a thing every client draws.
  const scope = remedyOrigin(task.originRef);
  const kind = scope.ok ? scope.kind : 'ci';
  const causes = CAUSES_BY_KIND[kind];
  const subject = kind === 'ci' ? 'the CI failure you were dispatched to fix' : 'the review feedback you addressed';
  return {
    description:
      `Say why ${subject} happened, and what settled it. Call it once, at the end of your work, ` +
      'before you finish.\n\n' +
      'Most of this fleet’s time goes on exactly two things: answering red CI and answering review ' +
      'comments. Nothing anywhere records *why* — a flaky runner, a stale assertion and a real bug ' +
      'are the same red on every chart the operator has. You are the only one who knows, and you ' +
      'know it now. Two questions, and the second is the one that changes anything:\n\n' +
      '- **cause** — what was actually wrong.\n' +
      '- **guard** — what would have caught it before the push. Answer this one honestly even when it ' +
      'is unflattering: "the repository’s own check would have caught it" is a useful answer and ' +
      '"nothing would have" is a useful answer, and a fleet that always says the second learns ' +
      'nothing.\n\n' +
      'When the guard is "undocumented" you may also raise a **claim**: the thing about working ' +
      'this repository that, written down, would stop the next agent paying for it again. It goes to ' +
      'the same place `raise` writes to, so if two other agents have already hit the same wall your ' +
      'claim is recorded as agreeing with theirs rather than as a third copy of it. It reaches no ' +
      'other agent on your say-so.\n\n' +
      'This schedules nothing, closes nothing and is posted nowhere. It does not say your work is ' +
      'finished — nothing here replaces pushing the fix.',
    inputSchema: {
      type: 'object',
      properties: {
        cause: {
          type: 'string',
          enum: [...causes],
          description: causes.map((c) => `${c}: ${CAUSE_COPY[c].blurb}`).join('. '),
        },
        guard: {
          type: 'string',
          enum: [...GUARD_ORDER],
          description: GUARD_ORDER.map((g) => `${g}: ${GUARD_COPY[g].blurb}`).join('. '),
        },
        summary: {
          type: 'string',
          description:
            'One line: what was wrong, and what fixed it. Specific enough that the next agent handed ' +
            'this same check reads it and knows where to look — name the file, the assertion or the ' +
            'rule, not "a test was failing".',
        },
        claim: {
          type: 'string',
          description:
            'Optional, and only with guard "undocumented". One thing that is true of working this ' +
            'repository and would have saved this round — a line or two, in the words you would want ' +
            'to read it in. Your summary above is the observation behind it, so there is nothing to ' +
            'repeat here. Omit it unless the fact is genuinely written down nowhere; if it is in the ' +
            'tree and you did not read it, that is guard "documented" and no claim.',
        },
      },
      required: ['cause', 'guard', 'summary'],
    },
    handler: (args) => {
      if (!scope.ok) return toolError(scope.error);
      const parsed = validateRemedy(scope.kind, args);
      if (!parsed.ok) return toolError(`Remedy rejected: ${parsed.error}`);
      const result = deps.agents.recordRemedy(agent.id, parsed.submission);
      if (!result.ok) return toolError(result.error);
      const raised = result.raised;
      return ok({
        filed: true,
        pr: result.remedy.prNumber,
        kind: result.remedy.kind,
        cause: result.remedy.cause,
        guard: result.remedy.guard,
        // Whatever the fact path actually answered, and never a boolean standing
        // in for it — `raise`'s rule, and its reason: an agent that reads a
        // returned id as proof it filed something new says it again, louder. The
        // remedy above landed either way, including under the bar, because the
        // account of an event does not depend on what became of the claim.
        raised: raisedPayload(raised),
        note:
          'Recorded. It is read on the Yield panel, and the next agent dispatched for this check is ' +
          'handed it. Nothing is scheduled from it and your pull request is unchanged.' +
          raisedNote(raised),
      });
    },
  };
};

/** The claim's fate, as the agent reads it back. Null when it raised none. */
function raisedPayload(outcome: FactProposalOutcome | null): unknown {
  if (outcome === null) return null;
  if (outcome.outcome === 'barred') return { recorded: 'barred', barredBy: outcome.barredBy.id };
  return {
    recorded: outcome.outcome,
    id: outcome.fact.id,
    reach: outcome.fact.reach,
    corroborations: outcome.corroborations,
  };
}

/**
 * Which of the three happened, said in words as well as in the payload.
 *
 * `raise`'s rule applied here: an agent told only that something was "recorded"
 * cannot tell filing a claim from agreeing with one, and the two ask for opposite
 * things next — one is waiting on a second goal, the other is already there.
 */
function raisedNote(outcome: FactProposalOutcome | null): string {
  if (outcome === null) return '';
  if (outcome.outcome === 'barred') {
    return (
      ` Your claim was not raised: an operator has rejected it as not true ("${outcome.barredBy.claim}"). ` +
      `Take that as the answer, or raise the sharper version with \`raise\` naming ${outcome.barredBy.id} in ` +
      `contradicts.`
    );
  }
  if (outcome.outcome === 'filed') {
    return ' Your claim is raised, and reaches no other agent yet — a second goal seeing the same thing, or an operator, is what carries it further.';
  }
  return (
    ` Your claim was recorded as agreeing with one already raised — ${outcome.corroborations} independent ` +
    `${outcome.corroborations === 1 ? 'goal has' : 'goals have'} now seen it. Nothing else is needed from you.`
  );
}
