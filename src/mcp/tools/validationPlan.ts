import { z } from 'zod';
import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { twoAreaRefusal, validationCheckInputs, validationResourceInputs } from '../../validation/checkDocument.js';
import {
  AUTHORED_AMEND_NOTE,
  AUTHORED_SUPERSEDED_REASON,
  validateCheckSet,
  validationPlanIssue,
} from '../../validation/authoring.js';
import { withdrawResourceAsks } from '../../validation/ask.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const validationPlan: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Declare the validation check set for the delivered goal you were dispatched to write one for — the ' +
    'checks somebody runs against the finished thing to see that it actually works. It speaks for the ' +
    '**whole** set: what you declare is what the goal has, and you may call it once. A check is one run of ' +
    'the delivered goal and everything that run settles — a real environment, the state it wrote, the logs, ' +
    'the screen. Anything the diff, the type checker, the test suite or a green build already settles is not ' +
    'a check, and writing one sends a person out to redo work that is done. Declaring no checks at all is a ' +
    'complete answer where the permanent suite already settles the question, and it carries a reason.',
  inputSchema: toolSchema(
    z.object({
      note: z
        .string()
        .describe(
          'Where you went a different way from the plan’s hint, and why. The hint was written against code ' +
            'that did not exist yet and it binds nothing — but an operator approved this goal on the strength ' +
            'of it, so a departure nobody states makes their read at the approval gate worth nothing. Say so ' +
            'plainly, including where you followed it.',
        ),
      emptyReason: z
        .string()
        .describe(
          'Required when you declare no checks: what already settles the question — the suite area that now ' +
            'asserts it, the coverage part that built it. An empty set with no account of itself reads exactly ' +
            'like an agent that did nothing.',
        )
        .optional(),
      checks: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key.'),
            title: z.string().describe('One line, the headline.'),
            do: z
              .string()
              .describe(
                'The procedure, in markdown: the commands, the URL, the clicks. Concrete steps, written for ' +
                  'somebody who has not read the plan. What the check needs in order to be runnable opens it.',
              ),
            expect: z
              .string()
              .describe(
                'What a pass looks like, and where — the row, the log line, the ref that is gone, the screen. ' +
                  'One run settles several things: list all of them here rather than splitting the check.',
              ),
            uses: z
              .array(z.string())
              .describe('Names of declared resources this check needs. Names, never paths.')
              .optional(),
            covers: z.array(z.string()).describe('Part slugs this check exercises.').optional(),
            fleetCandidate: z
              .boolean()
              .describe(
                'Your nomination that an agent could run this rather than a person. A suggestion for whoever ' +
                  'decides — it dispatches nothing, and the hand-over is an operator’s press.',
              )
              .optional(),
            why: z.string().describe('Why an agent could run it. Kept only with the nomination.').optional(),
          }),
        )
        .describe('The whole check set. Omit it, with an emptyReason, to declare none.')
        .optional(),
      resources: z
        .array(
          z.object({
            name: z.string().describe('A file name, not a path.'),
            kind: z.enum(['fixture', 'access', 'reference', 'data']).optional(),
            note: z.string().optional(),
            provided: z.boolean().describe('False is "a check needs this and I cannot produce it".').optional(),
          }),
        )
        .describe(
          'Files a check needs that the repository does not have: a seeded fixture, a reference screenshot, a ' +
            'dump of real data. Not the place for a login, an account or an environment — what a check needs ' +
            'to be runnable goes in its "do", where the person running it reads it.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const issueNumber = validationPlanIssue(task.originRef);
    if (issueNumber === null) {
      return toolError(
        `validation_plan declares the whole check set for a goal whose validation plan you were dispatched ` +
          `to write, and this task's origin is ${task.originRef ?? '(none)'}, which is not that dispatch. If a ` +
          `check on the goal you are working is wrong, correct it with validation_amend, which speaks only for ` +
          `the checks it names.`,
      );
    }
    const origin = issueOrigin(issueNumber);
    const plan = deps.store.getPlanByOrigin(origin);
    if (!plan) {
      return toolError(
        `Issue #${issueNumber} has no plan, so a check set has nothing to hang off: "covers" names live part ` +
          'slugs, which are a property of the plan. Say what should be checked in an escalation instead.',
      );
    }
    const parsed = validateCheckSet(args);
    if (!parsed.ok) return toolError(`Check set rejected: ${parsed.error}`);
    const set = parsed.set;
    const parts = deps.store.listPlanParts(plan.id).map((p) => ({ slug: p.slug, coverage: p.coverage ?? null }));
    const spread = twoAreaRefusal(set.checks, parts);
    if (spread !== null) return toolError(`Check set rejected: ${spread}`);

    const resources = validationResourceInputs(set.resources);
    withdrawResourceAsks(
      deps.store,
      origin,
      resources.filter((r) => !r.provided).map((r) => r.name),
    );
    const written = deps.store.ingestValidation(origin, {
      checks: validationCheckInputs({ checks: set.checks, resources: set.resources }, parts),
      resources,
      supersededReason: AUTHORED_SUPERSEDED_REASON,
      amendNote: AUTHORED_AMEND_NOTE,
    });
    deps.store.recordValidationAuthoring(origin, {
      note: set.note,
      emptyReason: set.checks.length === 0 ? (set.emptyReason ?? null) : null,
    });

    return ok({
      authored: true,
      checks: written.map((c) => `${c.letter}. ${c.id}`),
      resources: resources.map((r) => r.name),
      means:
        written.length === 0
          ? 'no checks were declared, and your reason is on the goal so an operator can tell this from a ' +
            'planner that never ran. The goal’s validation sheet can now be assembled.'
          : 'the set is written and the goal’s validation sheet can now be assembled. Who runs each check is ' +
            'an operator’s decision, taken at the bench.',
    });
  },
});
