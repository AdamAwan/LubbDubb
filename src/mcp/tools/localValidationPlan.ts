import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const localValidationPlan: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Record the test plan for the change you were sent to validate. Write it first, before the environment is ' +
    "up — a bring-up takes minutes and this is what that wait is worth spending on. It lands on the goal's " +
    'page the moment you send it, so the operator can see what you are about to do while it is still happening. ' +
    'One plan per validation: send it once, then run it.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The plan, in markdown. Cover what changed and nothing else — the diff on this branch, not the whole ' +
          'product. For each step say what you are checking, what you will do, and what a pass looks like, ' +
          'specifically enough that somebody else could run it and get the same answer.',
      },
    },
    required: ['plan'],
  },
  handler: (args) => {
    const desk = deps.localValidations?.();
    if (!desk)
      return toolError('Local validation is not wired on this deployment, so there is nowhere to record a plan.');
    const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
    if (plan === '') return toolError('plan is required — a plan with nothing in it records nothing.');
    const written = desk.recordPlan(task, plan);
    if (!written.ok) return toolError(written.error);
    return ok({
      recorded: 'plan',
      means:
        'the operator can see it now. Next: watch for the environment with local_run_read, and when it is ' +
        'running, open the application and work through this plan one step at a time.',
    });
  },
});
