import {
  CAUSES_BY_KIND,
  CAUSE_COPY,
  GUARD_COPY,
  GUARD_ORDER,
  remedyOrigin,
  validateRemedy,
} from '../../remedies/remedies.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const reportRemedy: ToolFactory = ({ deps, agent, task, ok }) => {
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
      'When the guard is "undocumented" — the thing that would have caught it is written down ' +
      'nowhere — `raise` it as well, in its own call: that is the one door, and it is where the next ' +
      'agent hitting the same wall will find it.\n\n' +
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
      },
      required: ['cause', 'guard', 'summary'],
    },
    handler: (args) => {
      if (!scope.ok) return toolError(scope.error);
      const parsed = validateRemedy(scope.kind, args);
      if (!parsed.ok) return toolError(`Remedy rejected: ${parsed.error}`);
      const result = deps.agents.recordRemedy(agent.id, parsed.submission);
      if (!result.ok) return toolError(result.error);
      return ok({
        filed: true,
        pr: result.remedy.prNumber,
        kind: result.remedy.kind,
        cause: result.remedy.cause,
        guard: result.remedy.guard,
        note:
          'Recorded. It is read on the Yield panel, and the next agent dispatched for this check is ' +
          'handed it. Nothing is scheduled from it and your pull request is unchanged.',
      });
    },
  };
};
