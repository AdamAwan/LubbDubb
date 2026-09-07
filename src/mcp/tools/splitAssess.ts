import { z } from 'zod';
import { originIssueNumber } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { splitTargetPr } from '../../prSplit.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

const MIN_CONCEPTS = 2;

export const splitAssess: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Report whether the PULL REQUEST you were dispatched for is one piece of work or several. You are not ' +
    'reviewing it and you are not splitting it — you are answering the one question a file count cannot: ' +
    'does this diff hold more than one concept. Breadth is the prompt to look, never the answer: a rename ' +
    'across sixty files is one concept, and twelve files spanning a schema change, an endpoint and an ' +
    'unrelated refactor are three. Answer `coherent` and nothing else happens and nothing asks again. ' +
    'Answer `split` and name the concepts, then propose the plan that separates them with plan_correct — ' +
    'an operator decides, and neither the pull request nor the agent on it is stopped meanwhile.',
  inputSchema: toolSchema(
    z.object({
      verdict: z
        .enum(['split', 'coherent'])
        .describe(
          '`coherent` if the diff is one concept, however wide. `split` if it holds work that should have ' +
            'been separate pull requests.',
        ),
      concepts: z
        .array(z.string())
        .describe(
          'On `split`, the concepts you found — one short name each, at least two, in the order they would ' +
            'have to land. Each one is a part of the plan you are about to propose. Omit on `coherent`.',
        )
        .optional(),
      reason: z
        .string()
        .describe(
          'What you saw in the diff that decided it, in a few sentences. On `coherent` this is the whole ' +
            'record of why a wide pull request was left alone, so “it is all related” is not a reason.',
        ),
      files: z.number().describe('How many files the diff changes, as you counted them on the branch.'),
    }),
  ),
  handler: (args) => {
    const prNumber = splitTargetPr(task.originRef);
    const issueNumber = originIssueNumber(task.originRef);
    if (prNumber === null || issueNumber === null) {
      return toolError(
        'split_assess is for an agent dispatched to size up a pull request, and this run was dispatched for ' +
          `${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      );
    }
    const input = args as { verdict?: unknown; concepts?: unknown; reason?: unknown; files?: unknown };
    const verdict = input.verdict === 'split' || input.verdict === 'coherent' ? input.verdict : null;
    if (verdict === null) return toolError('Verdict rejected: it must be "split" or "coherent".');

    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '')
      return toolError('Verdict rejected: the reason is what an operator reads instead of re-reading the diff.');

    const files =
      typeof input.files === 'number' && Number.isFinite(input.files) ? Math.max(0, Math.trunc(input.files)) : null;
    if (files === null) return toolError('Verdict rejected: give the number of files the diff changes.');

    const concepts = Array.isArray(input.concepts)
      ? input.concepts.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
      : [];
    if (verdict === 'split' && concepts.length < MIN_CONCEPTS) {
      return toolError(
        `Verdict rejected: a split needs at least ${MIN_CONCEPTS} named concepts. Name them, or answer ` +
          '"coherent" if you cannot.',
      );
    }

    const recorded = deps.store.recordPrSplitVerdict({
      prNumber,
      issueNumber,
      verdict,
      concepts: verdict === 'split' ? concepts : [],
      reason,
      files,
      agentId: agent.id,
    });

    if (recorded.verdict === 'coherent') {
      return ok({
        verdict: 'coherent',
        pullRequest: prNumber,
        means:
          'this pull request is left as it is and nothing asks about its width again. Nothing else is needed ' +
          'from you — do not review the change and do not touch the branch.',
      });
    }
    return ok({
      verdict: 'split',
      pullRequest: prNumber,
      concepts: recorded.concepts,
      means:
        `PR #${prNumber} is recorded as holding ${recorded.concepts.length} concepts. That recording splits ` +
        'nothing on its own: propose the plan that does, with plan_correct, in this same turn — one part per ' +
        'concept, the concept this pull request should keep first and under the slug its part already has. ' +
        'An operator decides. Do not close the pull request, push to its branch, or open another.',
    });
  },
});
