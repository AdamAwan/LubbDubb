import { z } from 'zod';
import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { validationCheckAmendments, validationResourceInputs } from '../../validation/checkDocument.js';
import { NO_STEP_CAPABILITIES } from '../../validation/steps.js';
import { amendmentNote, validateAmendment, validationAmendIssue, withdrawalReason } from '../../validation/amend.js';
import { withdrawResourceAsks } from '../../validation/ask.js';
import type { ValidationCheck } from '../../types.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const validationAmend: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Correct the validation plan for the goal you are working on — the checks a person runs against the ' +
    'finished goal to see that it actually works. Use it when a check no longer describes the thing you built: ' +
    'the screen moved, the command was renamed, the approach changed, or the plan simply missed something ' +
    'worth checking. Merge-only: checks you do not name are left exactly as they are, so you can correct one ' +
    'check without knowing about the others. Rewording a check withdraws whatever result somebody had already ' +
    'recorded against it, and you are told when that happens — so fix a wrong check, but do not rewrite a ' +
    'check you merely failed. A check you add answers to the bar the plan does: it is something that can only ' +
    'be found out by *running* the delivered goal — a real environment, the state it wrote, the logs, the ' +
    'screen. Anything the diff, the test suite, the type checker or a green build already settles is not a ' +
    'check, and adding one sends a person out to redo work that is done. One run of the thing is one check: ' +
    'if what you are adding would be run in the same sitting as a check that already exists, widen that ' +
    'check instead of adding a second one beside it.',
  inputSchema: toolSchema(
    z.object({
      note: z
        .string()
        .describe(
          'Why the plan is changing, in a sentence. This is the whole of what an operator sees when a check ' +
            'they read yesterday says something else today, so write what changed and why — not "updated".',
        ),
      checks: z
        .array(
          z.object({
            id: z.string().describe('Stable lowercase kebab-case id, and the merge key.'),
            title: z.string().describe('One line, the headline.'),
            do: z
              .string()
              .describe(
                'The procedure a person follows, in markdown: the commands, the URL, the clicks. Concrete ' +
                  'steps, written for somebody who has not read the plan.',
              ),
            expect: z
              .string()
              .describe(
                'What they would see, and where — the row, the log line, the ref that is gone, the screen. ' +
                  'A check that cannot say this is not a check.',
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
                  'decides — it dispatches nothing, and you cannot know what logins this deployment has.',
              )
              .optional(),
            steps: z
              .array(
                z.object({
                  kind: z
                    .enum(['browser', 'suite', 'screenshot', 'state', 'signal', 'measure', 'manual'])
                    .describe(
                      '"browser" drives the application; "suite" runs a named area of the project’s own browser ' +
                        'suite; "screenshot" captures the screen; "state" reads the deployed store; "signal" reads ' +
                        'logs and error records; "measure" reads a metric; "manual" is something only a person can do.',
                    ),
                  do: z.string().describe('What this step does, concretely.'),
                  area: z
                    .string()
                    .describe(
                      'A "suite" step only, and required on one: the area to run, copied **exactly** from what the ' +
                        'runner was listed as offering. It is compared character for character, so an area the ' +
                        'suite does not offer can never run. It is also what gives the check its area.',
                    )
                    .optional(),
                  when: z
                    .enum(['inline', 'deferred'])
                    .describe(
                      'A "manual" step only. "deferred" is *somebody looks at this afterwards* and costs the run ' +
                        'nothing. "inline" stops the run where it sits — no agent holds a session across a ' +
                        'person’s day — so an inline step in an otherwise automated plan splits the check into two ' +
                        'runs with a wait between them. Default is "inline"; say "deferred" when you mean it.',
                    )
                    .optional(),
                }),
              )
              .describe(
                'The test plan: one ordered journey through the delivered goal, in order. The ordering is the ' +
                  'point — a store or log reading whose subject is what the browser steps just did is meaningless ' +
                  'taken before them. Who carries each step is **not yours to say**: it is read off what the ' +
                  'deployment declares it can drive. Omit it to leave the check as prose.',
              )
              .optional(),
            why: z.string().describe('Why an agent could run it. Kept only with the nomination.').optional(),
          }),
        )
        .describe(
          'Checks to add or amend. An id this goal already has is merged onto that check; a new id is added ' +
            'and gets the next free letter. Re-use the exact id when you are amending — it is the merge key.',
        )
        .optional(),
      withdraw: z
        .array(
          z.object({
            id: z.string(),
            reason: z.string().describe('Why this is no longer worth checking.'),
          }),
        )
        .describe(
          'Checks that should no longer be asked for, each with a reason. Withdrawing keeps the check on the ' +
            'record, greyed, with your reason on it — it does not delete it. Withdraw a check the goal no longer ' +
            'needs; do not withdraw one you could not get to pass.',
        )
        .optional(),
      resources: z
        .array(
          z.object({
            name: z.string().describe('A file name, not a path.'),
            kind: z.enum(['fixture', 'access', 'reference', 'data']).optional(),
            note: z.string().optional(),
            provided: z.boolean().describe('False is "I need this and cannot produce it".').optional(),
          }),
        )
        .describe(
          'Files a check needs that the repository does not have: a seeded fixture, a reference screenshot, a ' +
            'dump of real data. Merged by name; nothing here removes one. Not the place for a login, an account ' +
            'or an environment — what a check needs to be runnable goes in its "do", where the person running it ' +
            'reads it. Set "provided": false for a file you cannot produce yourself, and the harness asks a ' +
            'person to put it on disk once the goal is delivered.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const goal = validationAmendIssue(task.originRef);
    if (!goal.ok) return toolError(goal.error);
    const origin = issueOrigin(goal.issueNumber);
    const plan = deps.store.getPlanByOrigin(origin);
    if (!plan) {
      return toolError(
        `Issue #${goal.issueNumber} has no plan yet, so it has no validation plan to amend. Say what should be ` +
          'checked in your conclusion instead.',
      );
    }
    const parsed = validateAmendment(args);
    if (!parsed.ok) return toolError(`Amendment rejected: ${parsed.error}`);
    const amendment = parsed.amendment;
    const slugs = deps.store.listPlanParts(plan.id).map((p) => p.slug);

    const resources = validationResourceInputs(amendment.resources);
    const known = [
      ...new Set([...deps.store.listValidationResources(origin).map((r) => r.name), ...resources.map((r) => r.name)]),
    ];
    const nowProvided = new Set(resources.filter((r) => r.provided).map((r) => r.name));
    withdrawResourceAsks(
      deps.store,
      origin,
      deps.store
        .listValidationResources(origin)
        .filter((r) => !nowProvided.has(r.name))
        .map((r) => r.name),
    );
    const result = deps.store.amendValidation(origin, {
      checks: validationCheckAmendments(amendment.checks, known, slugs, deps.stepCapabilities ?? NO_STEP_CAPABILITIES),
      withdraw: amendment.withdraw.map((w) => ({ id: w.id, reason: withdrawalReason(w.reason) })),
      resources,
      note: amendmentNote(amendment.note),
    });

    const named = (checks: ValidationCheck[]): string[] => checks.map((c) => `${c.letter}. ${c.id}`);
    const withdrew = result.reworded.filter((c) => c.revision?.state != null);
    return ok({
      amended: true,
      added: named(result.added),
      reworded: named(result.reworded),
      unchanged: result.unchanged,
      withdrawn: result.withdrawn,
      ...(result.unknown.length > 0
        ? { notFound: result.unknown, notFoundMeans: 'no live check on this goal has that id — nothing was withdrawn' }
        : {}),
      ...(withdrew.length > 0
        ? {
            withdrewResults: withdrew.map((c) => `${c.letter}. ${c.id} was ${c.revision?.state ?? ''}, now unrun`),
            withdrewResultsMeans:
              'you changed what a pass means for these, so the reading somebody had recorded no longer holds ' +
              'and they are back to unrun. The operator is shown what the check used to say.',
          }
        : {}),
    });
  },
});
