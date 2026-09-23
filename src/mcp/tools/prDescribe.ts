import { z } from 'zod';
import { toolSchema } from '../schema.js';
import { PR_BODY, prBodyRefusal } from '../../pr/prBody.js';
import { describeTargetPr } from '../../pr/prDescription.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/07-pull-requests.md#the-agents-draft

export const prDescribe: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Write the description of the pull request you were dispatched to describe. The operator handed it to ' +
    'you; the harness puts what you send above the footer of the pull request on its next pulse. Send it ' +
    'once — a second call replaces the first.',
  inputSchema: toolSchema(
    z.object({
      body: z
        .string()
        .describe(
          `The description, as a bullet list: at most ${PR_BODY.bullets} bullets, why the change is needed ` +
            'first and what it does after, one line each. No headings, no prose paragraphs, and no issue ' +
            'reference — the footer already carries it. These are checked and a body that breaks them is ' +
            `refused: every line starts with \`- \`, no bullet runs past ${PR_BODY.bulletChars} characters, ` +
            'no semicolons, no clauses hung off a dash, and the plainest word that is still true.',
        ),
    }),
  ),
  handler: (args) => {
    const prNumber = describeTargetPr(task.originRef);
    if (prNumber === null)
      return toolError(
        'pr_describe is for an agent dispatched to describe a pull request, and this run was dispatched for ' +
          `${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      );
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (body === '') return toolError('pr_describe rejected: the body is empty. Say what the change does.');
    const refusal = prBodyRefusal(body);
    if (refusal !== null) return toolError(`pr_describe rejected: ${refusal}`);
    const written = deps.store.prDescriptions.writeHandedDraft({ prNumber, text: body });
    if (written === null)
      return toolError(`pr_describe rejected: nobody handed PR #${prNumber}'s description to an agent.`);
    return ok({
      pullRequest: prNumber,
      means:
        'recorded. The harness writes it onto the pull request on its next pulse. Nothing else is needed — do ' +
        'not touch the branch.',
    });
  },
});
