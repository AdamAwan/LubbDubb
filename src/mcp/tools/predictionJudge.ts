import { z } from 'zod';
import { issueOriginRef, parseIssueOrigin } from '../../issueOrigins.js';
import { toolError } from '../protocol.js';
import { toolSchema } from '../schema.js';
import type { ToolFactory } from './context.js';

// → docs/spec/14-persistence.md#the-prediction-judge

const SLOTS = ['locus', 'cause', 'split', 'avoid'] as const;
const MARKS = ['matched', 'missed', 'not-applicable'] as const;

type Mark = (typeof MARKS)[number];

const MarkField = z.enum(MARKS).nullable().optional();

export const predictionJudge: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Your one tool. Call it with action "read" first: it hands you what the operator predicted about this ' +
    "goal's plan before any plan existed, slot by slot, and the plan the fleet then wrote. Then call it with " +
    'action "mark", marking each filled slot matched (the plan does what the slot said), missed (it does ' +
    'not) or not-applicable (the plan does not speak to it). Mark only filled slots. Your reading is kept ' +
    "beside the operator's own and shown to them; it changes nothing about the goal.",
  inputSchema: toolSchema(
    z.object({
      action: z.enum(['read', 'mark']).describe('"read" to be handed the prediction and the plan; "mark" to answer.'),
      locus: MarkField.describe('With "mark": the locus slot.'),
      cause: MarkField.describe('With "mark": the cause slot.'),
      split: MarkField.describe('With "mark": the split slot.'),
      avoid: MarkField.describe('With "mark": the avoid slot.'),
    }),
  ),
  handler: (args) => {
    const parsed = parseIssueOrigin(task.originRef);
    if (parsed === null || parsed.family !== 'predictionJudge')
      return toolError(
        'prediction_judge is for the agent dispatched to judge a goal’s prediction, and this run was ' +
          `dispatched for ${task.originRef ?? 'no origin'}.`,
      );
    if (deps.judge === undefined) return toolError('This harness has no judge channel. Nothing was read or recorded.');
    const goal = issueOriginRef('root', parsed.issueNumber);
    const input = args as Record<string, unknown>;
    if (input.action === 'read') {
      const brief = deps.judge.brief(goal);
      if (brief === null) return toolError('There is nothing to judge on this goal. Stop here.');
      return ok({ brief });
    }
    if (input.action !== 'mark') return toolError('Say "read" or "mark" as the action.');
    const marks: Partial<Record<(typeof SLOTS)[number], Mark | null>> = {};
    for (const slot of SLOTS) {
      const value = input[slot];
      if (value === undefined || value === null) continue;
      if (!(MARKS as readonly unknown[]).includes(value))
        return toolError(`The ${slot} mark must be one of ${MARKS.join(', ')}.`);
      marks[slot] = value as Mark;
    }
    const recorded = deps.judge.record(goal, marks);
    if (!recorded.ok) return toolError(`Not recorded: ${recorded.error}.`);
    return ok({ recorded: true, note: 'Recorded. Your work here is done — end your turn.' });
  },
});
