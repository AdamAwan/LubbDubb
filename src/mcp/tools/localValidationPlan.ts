import { z } from 'zod';
import { toolError } from '../protocol.js';
import { toolSchema } from '../schema.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const localValidationPlan: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Record the test plan for the change you were sent to validate. Write it first, before the environment is ' +
    "up — a bring-up takes minutes and this is what that wait is worth spending on. It lands on the goal's " +
    'page the moment you send it, so the operator can see what you are about to do while it is still happening. ' +
    'One plan per validation: send it once, then run it.',
  inputSchema: toolSchema(
    z.object({
      plan: z
        .string()
        .describe(
          'The plan, in markdown. Cover what changed and nothing else — the diff on this branch, not the whole ' +
            'product. For each step say what you are checking, what you will do, and what a pass looks like, ' +
            'specifically enough that somebody else could run it and get the same answer.',
        ),
      setup: z
        .string()
        .describe(
          'The state the plan needs that the environment may not have — the flags to turn on, the configuration ' +
            'to change, the records to create — and how you will create each once the environment is running. ' +
            'Markdown. Leave it out only if the plan needs nothing set up.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const desk = deps.localValidations?.();
    if (!desk)
      return toolError('Local validation is not wired on this deployment, so there is nowhere to record a plan.');
    const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
    if (plan === '') return toolError('plan is required — a plan with nothing in it records nothing.');
    const setup = typeof args.setup === 'string' ? args.setup.trim() : '';
    const written = desk.recordPlan(task, setup === '' ? plan : `${plan}\n\n## Set-up\n\n${setup}`);
    if (!written.ok) return toolError(written.error);
    return ok({
      recorded: 'plan',
      means:
        'the operator can see it now. Next: watch for the environment with local_run_read, and when it is ' +
        'running, set up what the plan needs, then open the application and work through it one step at a time.',
    });
  },
});
