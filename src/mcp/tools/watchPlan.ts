import { z } from 'zod';
import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { WatchSchema, watchCheckInputs } from '../../validation/watchDocument.js';
import { UNTIL_EXPLAINED } from '../../validation/watchQueryShape.js';
import { watchAuthoringIssue, watchOwed } from '../../validation/watchAuthoring.js';
import { watchSourceRefusal } from '../../environments/watchSource.js';
import { toolError } from '../protocol.js';
import type { McpToolDeps, ToolFactory } from './context.js';
import type { GoalWatch, GoalWatchInput } from '../../types.js';

// → docs/spec/11-mcp-tools.md

const SourceField = z
  .string()
  .describe(
    'The environment source this check reads, by name — the list under the watch notes in your prompt. ' +
      'Leave it out where every environment has only one source.',
  )
  .optional();

const ChangedField = z
  .string()
  .describe(
    'Where this check departs from the plan’s hint — an intent it replaces, rewords or was never in — ' +
      'and why, in a sentence. Leave it out where the check is what the hint asked for. The operator ' +
      'sees the check marked "changed from plan" with these words.',
  )
  .optional();

const WatchPlanInput = z.object({
  note: z
    .string()
    .describe(
      'Required on every call: where the checks departed from the plan’s hint, and why — including where ' +
        'you followed it. "The plan said stops timing out; part 2 added a retry, so a timeout no longer ' +
        'means a failure, and the honest check is fails after all retries." The operator who ticked the ' +
        'hint reads this before accepting anything.',
    ),
  emptyReason: z
    .string()
    .describe(
      'Required when you declare no checks: why nothing running behaves differently — a refactor, a docs ' +
        'change, a build fix. It is shown to the operator as the goal’s outcome.',
    )
    .optional(),
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
              'whatever the number is, which reads as one occurrence for ever, and is refused. It must ' +
              'carry "{since}", bounding it to the period being watched — "| where timestamp > ' +
              'datetime({since})", with your own timestamp column — which the harness replaces with the ' +
              'moment the work arrived on the environment. Without it the query answers about the whole ' +
              `retention period and counts the occurrences your fix was for; it is refused. ${UNTIL_EXPLAINED}`,
          ),
        presence: z
          .string()
          .describe(
            'A second query whose only job is to prove the code path is running at all. Required: a ' +
              'query naming an operation that does not exist answers zero rows, and zero rows looks ' +
              'exactly like a healthy release — so without one your fix would be reported verified on ' +
              'the strength of a typo. It returns rows too, and must not aggregate: a count can never ' +
              'answer zero, so an aggregated presence query proves nothing and is refused. It carries ' +
              '"{since}" too: presence is asked whether the path is running now, not whether it ran at ' +
              'some point in the retention period.',
          ),
        tolerate: z
          .number()
          .describe(
            'How many rows the query may answer before this reads as a regression. The harness counts ' +
              'them; your query returns the occurrences. Defaults to zero.',
          )
          .optional(),
        why: z.string().describe('Why this is the signal that matters.').optional(),
        source: SourceField,
        changedFromHint: ChangedField,
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
        query: z
          .string()
          .describe(
            'Answers exactly one row with a numeric "value". It carries "{since}" — "| where timestamp > ' +
              'datetime({since})", with your own timestamp column — which the harness replaces with the ' +
              'moment the work arrived, so the number is about the period being watched rather than ' +
              `about the whole retention period. It is refused without one. ${UNTIL_EXPLAINED}`,
          ),
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
              'runs your query over the period before the merge the moment you record it, and compares ' +
              'against that. A measure declaring neither cannot fail and is refused.',
          ),
        unit: z.string().describe('ms, %, per minute — drawn beside the number, never parsed.').optional(),
        why: z.string().optional(),
        source: SourceField,
        changedFromHint: ChangedField,
      }),
    )
    .describe(
      'One number each: a percentile, a rate, a duration, a queue depth. The query answers exactly one ' +
        'row carrying a numeric "value" column.',
    )
    .optional(),
});

export const watchPlan: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Declare the post-deploy watch for the delivered goal you were dispatched to assess or to write one for: ' +
    'what a running system would have to show, once this ships, for the work to have done what it claimed — ' +
    'read on a schedule for a couple of days after it reaches each environment. It speaks for the **whole** ' +
    'watch: what you declare is what the goal has, and a check you omit is withdrawn, except one the operator ' +
    'wrote. You are standing in the merged code, so you can see the message template, the operation name and ' +
    'the shape of the fix — write the queries against those. Every check is put to an environment once as you ' +
    'record it, and what comes back unproven is in the reply, so you can fix it and call again. Nothing runs on ' +
    'a schedule until the operator accepts the set. Declaring no checks is a complete answer where nothing ' +
    'running behaves differently, and it carries an emptyReason.',
  inputSchema: toolSchema(WatchPlanInput),
  handler: async (args) => {
    const standing = goalStanding(deps, task.originRef);
    if ('refusal' in standing) return toolError(standing.refusal);
    const { origin, live } = standing;
    const declared = declaration(args);
    if ('error' in declared) return toolError(declared.error);
    const { checks, note, emptyReason } = declared;
    const operators = new Set(live.filter((c) => c.authored === 'operator').map((c) => c.id));
    const taken = checks.filter((c) => operators.has(c.id)).map((c) => c.id);
    if (taken.length > 0)
      return toolError(
        `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} the operator's own check id. Their checks stand ` +
          'whatever you declare; give yours a different id, or leave it out.',
      );
    const refusals = checks
      .map((c) => watchSourceRefusal(deps.watchEnvironments ?? [], c))
      .filter((r): r is string => r !== null);
    if (refusals.length > 0) return toolError(`Watch rejected: ${refusals.join('; ')}`);
    deps.store.watches.authorWatchPlan(origin, checks, { note, emptyReason: checks.length === 0 ? emptyReason : null });
    const dryRun = (await deps.watch?.run(origin)) ?? [];
    return ok({ authored: true, proposed: checks.map((c) => c.id), dryRun, means: authoredMeans(checks, dryRun) });
  },
});

/**
 * The goal this dispatch may write the watch for, with its live checks — or why it may not now: the watch is
 * owed, or written and still proposed, which a second call in the same turn replaces.
 */
function goalStanding(
  deps: McpToolDeps,
  originRef: string | null,
): { origin: string; live: GoalWatch[] } | { refusal: string } {
  if (deps.watchHintRequired !== true)
    return {
      refusal:
        'No environment on this deployment declares a `watch`, so a query written here would be put to nothing. ' +
        'Say what is worth watching in your verdict instead.',
    };
  const issueNumber = watchAuthoringIssue(originRef);
  if (issueNumber === null)
    return {
      refusal:
        `watch_plan declares the whole post-deploy watch for a goal, and only two dispatches may: the assessor ` +
        `that has just answered "delivered" for it, and the agent sent to write the watch. This task's origin ` +
        `is ${originRef ?? '(none)'}, which is neither. If you added a log line, a metric or an exception ` +
        'that says whether this is behaving, say so in the pull request description — the assessor reads it.',
    };
  const origin = issueOrigin(issueNumber);
  const { store } = deps;
  if (store.verdicts.getDelivery(origin) === null)
    return {
      refusal:
        `Issue #${issueNumber} has no standing delivery, so there is nothing to write a watch against yet. The ` +
        'watch is written once, against code that is not going to move again — call assess_issue first, and ' +
        'write it only if that verdict is "delivered".',
    };
  const record = store.watches.getWatchPlanRecord(origin);
  const proposed = record?.authoredAt != null && record.acceptedAt === null;
  if (proposed || watchOwed({ record, planned: store.plans.getPlanByOrigin(origin) !== null }))
    return { origin, live: store.watches.listLiveGoalWatches(origin) };
  if (record === null)
    return {
      refusal:
        `Issue #${issueNumber}'s post-deploy watch was never asked for — it was delivered before the assessor ` +
        'wrote watches, while no environment declared one, or already carrying live checks. Nothing is owed; ' +
        'there is nothing for you to declare.',
    };
  return {
    refusal:
      record.authoredAt !== null
        ? `Issue #${issueNumber}'s watch is already written and accepted. The operator edits it on the goal's ` +
          'own page; there is nothing for you to declare.'
        : `Issue #${issueNumber} has no plan, so there is no hint to write a watch against.`,
  };
}

type Declared = {
  checks: (GoalWatchInput & { changedFromHint: string | null })[];
  note: string;
  emptyReason: string;
};

/** The call's arguments as a whole watch, held to `WatchSchema`, or the refusal. */
function declaration(args: Record<string, unknown>): Declared | { error: string } {
  const note = typeof args['note'] === 'string' ? args['note'].trim() : '';
  if (note === '')
    return {
      error:
        'note is required — say where the checks departed from the plan’s hint and why, including where you followed it.',
    };
  const changed = new Map<string, string>();
  const parsed = WatchSchema.safeParse({
    signals: withoutChangeNotes(args['signals'] ?? [], changed),
    measures: withoutChangeNotes(args['measures'] ?? [], changed),
  });
  if (!parsed.success) return { error: `Watch rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  const checks = watchCheckInputs(parsed.data).map((c) => ({ ...c, changedFromHint: changed.get(c.id) ?? null }));
  const emptyReason = typeof args['emptyReason'] === 'string' ? args['emptyReason'].trim() : '';
  if (checks.length === 0 && emptyReason === '')
    return {
      error:
        'No checks were declared and no emptyReason was given. Declaring nothing is a legitimate answer, but it ' +
        'is said, never left unsaid: give the reason nothing running behaves differently, or declare a check.',
    };
  return { checks, note, emptyReason };
}

function authoredMeans(checks: readonly unknown[], dryRun: readonly string[]): string {
  if (checks.length === 0)
    return 'no checks were declared, and your reason is on the goal for the operator to read. Nothing will be watched after this ships.';
  if (dryRun.length === 0)
    return (
      'each check was put to an environment once and came back answering. The set waits for the operator to ' +
      'accept it; nothing runs on a schedule before that.'
    );
  return (
    'each line in dryRun is a check whose query did not come back proven. Fix the query and call watch_plan ' +
    'again with the whole watch — it replaces this set. The set waits for the operator to accept it either way.'
  );
}

/** `changedFromHint` is the assessor's annotation, not part of the declaration `WatchSchema` holds. */
function withoutChangeNotes(list: unknown, changed: Map<string, string>): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return item;
    const { changedFromHint, ...rest } = item as Record<string, unknown>;
    if (typeof changedFromHint === 'string' && changedFromHint.trim() !== '' && typeof rest['id'] === 'string')
      changed.set(rest['id'], changedFromHint.trim());
    return rest;
  });
}
