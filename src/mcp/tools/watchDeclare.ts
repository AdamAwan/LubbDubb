import { z } from 'zod';
import { issueOriginHead, issueOriginNumber } from '../../issueOrigins.js';
import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { WatchSchema, watchCheckInputs } from '../../validation/watchDocument.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const watchDeclare: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Declare, or correct, what a running system would have to show for the work you just did to have done ' +
    'what it claimed — read on a schedule for a couple of days after it reaches an environment. Use it when ' +
    'you added a log line, an exception, a metric or a counter that says whether this is behaving: you are ' +
    'the only party that knows the message template, the operation name and the property you wrote, and ' +
    'nobody downstream can recover them. Also use it to correct a check the plan declared where your fix ' +
    'changed what the right question is — a timeout fixed by adding a retry does not stop producing ' +
    'timeouts, and the honest signal becomes "the job fails after retries". Merge-only: a check you do not ' +
    'name is left exactly as it is, and the id is the merge key. Nothing you declare here runs until the ' +
    'operator accepts it, because the query runs against their telemetry with their credential — so write ' +
    'the query you would want run, and say in "note" why it is the right question.',
  inputSchema: toolSchema(
    z.object({
      note: z
        .string()
        .describe(
          'Why this is the right thing to watch, in a sentence or two. This is the whole of what the ' +
            'operator reads when deciding whether to accept the query, so say what you added and what a bad ' +
            'reading would mean.',
        ),
      signals: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key.'),
            title: z.string().describe('One line: what stopping happening would look like.'),
            query: z
              .string()
              .describe(
                "The query, in your telemetry's own language. It reaches the shell as a variable's value " +
                  'and is never interpolated into a command. It returns **one row per occurrence** and the ' +
                  'harness counts the rows: do not aggregate it. A query ending in a count answers one row ' +
                  'whatever the number is, which reads as one occurrence for ever, and is refused.',
              ),
            presence: z
              .string()
              .describe(
                'A second query whose only job is to prove the code path is running at all. Required: a ' +
                  'query naming an operation that does not exist answers zero rows, and zero rows looks ' +
                  'exactly like a healthy release — so without one your fix would be reported verified on ' +
                  'the strength of a typo. It returns rows too, and must not aggregate: a count can never ' +
                  'answer zero, so an aggregated presence query proves nothing and is refused.',
              ),
            tolerate: z
              .number()
              .describe(
                'How many rows the query may answer before this reads as a regression. The harness counts ' +
                  'them; your query returns the occurrences. Defaults to zero.',
              )
              .optional(),
            why: z.string().describe('Why this is the signal that matters.').optional(),
          }),
        )
        .describe(
          'Things that should not be happening: an exception, a failure, a retry, a log line only written ' +
            'when something has gone wrong. Each query returns the matching rows themselves; the harness ' +
            'counts them, against a tolerance that is almost always zero.',
        )
        .optional(),
      measures: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key.'),
            title: z.string(),
            query: z.string().describe('Answers exactly one row with a numeric "value".'),
            expect: z
              .object({
                under: z.number().describe('A ceiling the number must stay below.').optional(),
                over: z.number().describe('A floor the number must stay above.').optional(),
                noWorseThan: z
                  .enum(['baseline'])
                  .describe(
                    'Compare against what this same query read before the work arrived. Read ' +
                      'lower-is-better; where a bigger number is the good news, declare an "over" instead.',
                  )
                  .optional(),
              })
              .describe(
                'What would count as a failure. Declare a threshold, or "noWorseThan": "baseline" — which ' +
                  'runs your query the moment the operator accepts it, days before the work arrives, and ' +
                  'compares against that. A measure declaring neither cannot fail and is refused.',
              ),
            unit: z.string().describe('ms, %, per minute — drawn beside the number, never parsed.').optional(),
            why: z.string().optional(),
          }),
        )
        .describe(
          'One number each: a percentile, a rate, a duration, a queue depth. The query answers exactly one ' +
            'row carrying a numeric "value" column.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const ref = task.originRef ?? '';
    const head = issueOriginHead(ref);
    if (head === null)
      return toolError(
        `watch_declare declares the post-deploy watch of the goal you are working on, and this task's ` +
          `origin is ${ref || '(none)'}, which names no issue.`,
      );
    if (issueOriginNumber('plan', ref) !== null)
      return toolError(
        `You are planning issue #${head.issueNumber}, so the watch is yours to *write*, not to amend. Declare the ` +
          `whole thing in plan_submit's "watch" block — that transport speaks for the entire check set, ` +
          'which is what a planner is entitled to do and an agent halfway through a part is not.',
      );
    const note = typeof args['note'] === 'string' ? args['note'].trim() : '';
    if (note === '')
      return toolError('note is required — say why this is the right thing to watch, in a sentence or two.');
    const parsed = WatchSchema.safeParse({ signals: args['signals'] ?? [], measures: args['measures'] ?? [] });
    if (!parsed.success)
      return toolError(`Declaration rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const checks = watchCheckInputs(parsed.data);
    if (checks.length === 0)
      return toolError('Nothing was declared. Give at least one signal or one measure, or do not call this.');
    const origin = issueOrigin(head.issueNumber);
    const { proposed } = deps.store.proposeGoalWatch(origin, checks, note);
    return ok({
      declared: proposed,
      pending: true,
      pendingMeans:
        'nothing here has been put to an environment. Each of these is drawn on the plan sheet as a pending ' +
        "change with accept and decline beside it, because the query runs against the operator's own " +
        'telemetry with their own credential. Accepting is also what runs it once, so a query that resolves ' +
        'nothing comes back to them there.',
    });
  },
});
