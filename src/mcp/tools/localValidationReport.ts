import { validateLocalValidationReport } from '../../localValidation/report.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const localValidationReport: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Say what you found when you ran your plan against the running application. Once, at the end. ' +
    '"passed" and "failed" are readings of the code, so report one only if you actually drove the thing: a ' +
    'green build, a port answering and a status of "running" are none of them evidence, and the whole reason ' +
    'this dispatch exists is that those had all already happened. If you could not get to the environment, or ' +
    'it never came up, or the steps needed something this deployment has not got, say "blocked" and what ' +
    'stopped you — that is a right answer and it records no reading. A "failed" report puts an agent on the ' +
    'branch to fix what you list, so list it precisely.',
  inputSchema: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        enum: ['passed', 'failed', 'blocked'],
        description:
          '"passed" — you ran the plan against the application and it did what it should. "failed" — you ran ' +
          'it and it did not; needs at least one finding. "blocked" — you could not run it, and nothing is ' +
          'recorded about whether the change works.',
      },
      summary: {
        type: 'string',
        description:
          'What you did and what you saw, in a few sentences. This is what the operator reads instead of ' +
          'running the plan themselves, so say what actually happened rather than that it passed.',
      },
      findings: {
        type: 'array',
        description:
          'What is wrong, one entry each. Required for "failed". These are handed verbatim to the agent that ' +
          'fixes them, so a finding that does not say what you did and what happened instead is one nobody ' +
          'can act on.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'One line naming the problem.' },
            detail: {
              type: 'string',
              description: 'What you did, what you expected, and what happened instead.',
            },
            severity: {
              type: 'string',
              enum: ['blocker', 'defect', 'nit'],
              description:
                '"blocker" — the change does not work. "defect" — it works but something is wrong. "nit" — ' +
                'worth saying, not worth blocking on. All three reach the fix agent; this decides what a ' +
                'person reads first.',
            },
            url: { type: 'string', description: 'The page you found it on, if there was one.' },
            screenshot: {
              type: 'string',
              description:
                'The file name of a screenshot you saved in the directory you were given — the name alone, ' +
                'not a path. It is drawn beside the finding.',
            },
          },
          required: ['title', 'detail', 'severity'],
        },
      },
      visited: {
        type: 'array',
        description: 'The pages you opened, so somebody can go and look at the same ones.',
        items: { type: 'string' },
      },
    },
    required: ['result', 'summary'],
  },
  handler: (args) => {
    const desk = deps.localValidations?.();
    if (!desk) return toolError('Local validation is not wired on this deployment, so there is nowhere to report to.');
    const parsed = validateLocalValidationReport(args);
    if (!parsed.ok) return toolError(`Report rejected: ${parsed.error}`);
    // The desk owns the fence and the staleness refusal alike: which validation this
    // is about comes off the dispatch origin, and whether the environment is still
    // the one that was planned against comes off `validationRunStale` — the same
    // predicate the sweep uses, so the two can never settle a row differently.
    const { result, ...rest } = parsed.report;
    const written = desk.report(task, { status: result, ...rest });
    if (!written.ok) return toolError(written.error);
    const { row } = written;
    return ok({
      reported: row.status,
      findings: row.findings.length,
      screenshots: row.screenshots.length,
      means:
        row.status === 'failed'
          ? `it is on the goal's page now, and an agent is dispatched to ${row.ref} to fix what you listed. Your run is over.`
          : row.status === 'blocked'
            ? "no reading was recorded about whether the change works, and your reason is on the goal's page for the operator. Your run is over."
            : "it is on the goal's page now, attributed to an agent rather than to a person. Your run is over.",
    });
  },
});
