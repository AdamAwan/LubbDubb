import { issueOrigin } from '../../plans/planning.js';
import { WatchSchema, watchCheckInputs } from '../../validation/watchDocument.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The working agent's half of the declaration.
 *
 * It is the only party in the system that knows what the code actually emits. A
 * planner cannot guess the message template of a log line that did not exist when
 * it wrote the plan, and nothing downstream can recover it — which is also the
 * second-order reason this tool exists at all: an agent told *if you added a log
 * line or a metric for this, declare the watch that reads it* has a reason to add
 * one. The declaration makes the fleet instrument its own work.
 *
 * **Nothing it writes is live.** A declaration lands as a pending amendment on
 * the plan sheet, with accept and decline beside it, because the query is run
 * inside the operator's own command with the operator's own credential — and that
 * approval is the whole authorisation story. Acceptance is what re-runs the dry
 * run and takes a measure's baseline.
 *
 * Merges on the check's slug exactly as `validation_amend` does
 * (`docs/spec/20-validation.md`), and refuses exactly what a plan document
 * refuses, because it parses with the plan document's own schema rather than a
 * second copy of it.
 * → `docs/spec/29-post-deploy-watch.md#the-working-agent-at-conclude-time`
 */
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
  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description:
          'Why this is the right thing to watch, in a sentence or two. This is the whole of what the ' +
          'operator reads when deciding whether to accept the query, so say what you added and what a bad ' +
          'reading would mean.',
      },
      signals: {
        type: 'array',
        description:
          'Things that should not be happening: an exception, a failure, a retry, a log line only written ' +
          'when something has gone wrong. Counted, against a tolerance that is almost always zero.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable lowercase kebab-case id, and the merge key.' },
            title: { type: 'string', description: 'One line: what stopping happening would look like.' },
            query: {
              type: 'string',
              description:
                "The query, in your telemetry's own language. It reaches the shell as a variable's value " +
                'and is never interpolated into a command.',
            },
            presence: {
              type: 'string',
              description:
                'A second query whose only job is to prove the code path is running at all. Required: a ' +
                'query naming an operation that does not exist answers zero rows, and zero rows looks ' +
                'exactly like a healthy release — so without one your fix would be reported verified on ' +
                'the strength of a typo.',
            },
            tolerate: { type: 'number', description: 'The count it must not exceed. Defaults to zero.' },
            why: { type: 'string', description: 'Why this is the signal that matters.' },
          },
          required: ['id', 'title', 'query', 'presence'],
        },
      },
      measures: {
        type: 'array',
        description:
          'One number each: a percentile, a rate, a duration, a queue depth. The query answers exactly one ' +
          'row carrying a numeric "value" column.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable lowercase kebab-case id, and the merge key.' },
            title: { type: 'string' },
            query: { type: 'string', description: 'Answers exactly one row with a numeric "value".' },
            expect: {
              type: 'object',
              description:
                'What would count as a failure. Declare a threshold, or "noWorseThan": "baseline" — which ' +
                'runs your query the moment the operator accepts it, days before the work arrives, and ' +
                'compares against that. A measure declaring neither cannot fail and is refused.',
              properties: {
                under: { type: 'number', description: 'A ceiling the number must stay below.' },
                over: { type: 'number', description: 'A floor the number must stay above.' },
                noWorseThan: {
                  type: 'string',
                  enum: ['baseline'],
                  description:
                    'Compare against what this same query read before the work arrived. Read ' +
                    'lower-is-better; where a bigger number is the good news, declare an "over" instead.',
                },
              },
            },
            unit: { type: 'string', description: 'ms, %, per minute — drawn beside the number, never parsed.' },
            why: { type: 'string' },
          },
          required: ['id', 'title', 'query', 'expect'],
        },
      },
    },
    required: ['note'],
  },
  handler: (args) => {
    // The same fence `validation_amend` carries, and for its reason: the origin
    // comes off the credential, so an agent working goal A cannot declare a watch
    // on goal B by asking. A planner is refused by name — it already has a
    // transport that declares the whole block, and two ways to say one thing
    // disagree about what an omission means.
    const ref = task.originRef ?? '';
    const match = /^issue:(\d+)(?::(.+))?$/.exec(ref);
    if (!match)
      return toolError(
        `watch_declare declares the post-deploy watch of the goal you are working on, and this task's ` +
          `origin is ${ref || '(none)'}, which names no issue.`,
      );
    if (match[2] === 'plan')
      return toolError(
        `You are planning issue #${match[1]}, so the watch is yours to *write*, not to amend. Declare the ` +
          `whole thing in plan_submit's "watch" block — that transport speaks for the entire check set, ` +
          'which is what a planner is entitled to do and an agent halfway through a part is not.',
      );
    const note = typeof args['note'] === 'string' ? args['note'].trim() : '';
    if (note === '')
      return toolError('note is required — say why this is the right thing to watch, in a sentence or two.');
    // Parsed by the plan document's own schema, so the two writers refuse exactly
    // the same things: a signal without a presence query, a measure that declares
    // neither a threshold nor a baseline, an id that is not kebab-case.
    const parsed = WatchSchema.safeParse({ signals: args['signals'] ?? [], measures: args['measures'] ?? [] });
    if (!parsed.success)
      return toolError(`Declaration rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const checks = watchCheckInputs(parsed.data);
    if (checks.length === 0)
      return toolError('Nothing was declared. Give at least one signal or one measure, or do not call this.');
    const origin = issueOrigin(Number(match[1]));
    const { proposed } = deps.store.proposeGoalWatch(origin, checks, note);
    return ok({
      declared: proposed,
      // Said plainly rather than left to be inferred from a silent success: an
      // agent that believed this was live would report a watch nobody approved.
      pending: true,
      pendingMeans:
        'nothing here has been put to an environment. Each of these is drawn on the plan sheet as a pending ' +
        "change with accept and decline beside it, because the query runs against the operator's own " +
        'telemetry with their own credential. Accepting is also what runs it once, so a query that resolves ' +
        'nothing comes back to them there.',
    });
  },
});
