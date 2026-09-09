import { z } from 'zod';
import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { StateSchema, stateQueryInputs } from '../../validation/stateDocument.js';
import { NO_STATE_EXECUTOR } from '../../remoteValidation/enabled.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const stateDeclare: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Declare, or correct, the question that says whether the data your change writes is shaped correctly — ' +
    'asked of a real environment’s own store once the work is deployed there. Use it when you added a ' +
    'column, a row, a status, a flag or a record: you are the only party who knows which table took it and ' +
    'what a correct row looks like, and a planner reading the repository as it stood before the work could ' +
    'not have known. Merge-only: a query you do not name is left exactly as it is, and the id is the merge ' +
    'key. Nothing you declare here runs anywhere until an operator has read the query and accepted it ' +
    'against one named environment — the query goes to their store with their credential — so write the ' +
    'query you would want run, and say in "why" what a wrong answer would mean.',
  inputSchema: toolSchema(
    z.object({
      queries: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key.'),
            title: z.string().describe('One line: what being wrong here would look like.'),
            query: z
              .string()
              .describe(
                'The query, in the store’s own language. It reaches the command as a variable’s value and is ' +
                  'never interpolated into a command string. It returns the matching **rows themselves** and ' +
                  'the harness counts them: do not aggregate it. A query ending in a count answers one row ' +
                  'whatever the number is, which defeats every guard the contract has, and is refused. ' +
                  'Read-only — nothing here may write to the environment.',
              ),
            presence: z
              .string()
              .describe(
                'A second query whose only job is to prove this store holds the thing at all. Required: a ' +
                  'query naming a column that is not there answers zero rows, and zero rows looks exactly ' +
                  'like a healthy release — so without one your change would be reported verified on the ' +
                  'strength of a typo. It returns rows too, and must not aggregate: a count can never answer ' +
                  'zero, so an aggregated presence query proves nothing and is refused.',
              ),
            why: z
              .string()
              .describe('Why this is the question that matters, and what a wrong answer means.')
              .optional(),
          }),
        )
        .describe('One question each about the data the change writes. Declaring none is a legitimate answer.'),
    }),
  ),
  handler: async (args) => {
    const ref = task.originRef ?? '';
    const match = /^issue:(\d+)(?::(.+))?$/.exec(ref);
    if (!match)
      return toolError(
        `state_declare declares the state queries of the goal you are working on, and this task's origin is ` +
          `${ref || '(none)'}, which names no issue.`,
      );
    if (match[2] === 'plan')
      return toolError(
        `You are planning issue #${match[1]}, so the state queries are yours to *write*, not to amend. ` +
          `Declare the whole thing in plan_submit's "state" block — that transport speaks for the entire set, ` +
          'which is what a planner is entitled to do and an agent halfway through a part is not. Two ways to ' +
          'say one thing that disagree about what an omission means is the drift the split exists to prevent.',
      );
    const state = deps.state;
    if (state === undefined || !state.configured()) return toolError(NO_STATE_EXECUTOR);
    const parsed = StateSchema.safeParse({ queries: args['queries'] ?? [] });
    if (!parsed.success)
      return toolError(`Declaration rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const queries = stateQueryInputs(parsed.data);
    if (queries.length === 0) return toolError('Nothing was declared. Give at least one query, or do not call this.');
    const origin = issueOrigin(Number(match[1]));
    const { declared, refusals } = await state.declare(origin, queries, 'agent');
    return ok({
      declared,
      approved: false,
      approvalMeans:
        'each of these was put once to an environment that can answer it, and what it said is drawn beside ' +
        'the query on the goal page. None of them runs on a sheet until an operator reads that and accepts ' +
        'the query against a named environment: consent to a place is not transferable, so accepting on ' +
        'acceptance does not accept it against production.',
      ...(refusals.length > 0
        ? {
            dryRun: refusals,
            dryRunNote:
              'Each of these was put once to the store it would ask and did not come back with a reading ' +
              'anybody could act on. Fix the query — or say why the change is wrong — and declare again. A ' +
              'query that resolves nothing forever is the failure this surface exists to catch.',
          }
        : {}),
    });
  },
});
