import { issueOrigin } from '../../plans/planning.js';
import { validationCheckAmendments, validationResourceInputs } from '../../validation/checkDocument.js';
import { amendmentNote, validateAmendment, validationAmendIssue, withdrawalReason } from '../../validation/amend.js';
import { withdrawResourceAsks } from '../../validation/ask.js';
import type { ValidationCheck } from '../../types.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

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
  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description:
          'Why the plan is changing, in a sentence. This is the whole of what an operator sees when a check ' +
          'they read yesterday says something else today, so write what changed and why — not "updated".',
      },
      checks: {
        type: 'array',
        description:
          'Checks to add or amend. An id this goal already has is merged onto that check; a new id is added ' +
          'and gets the next free letter. Re-use the exact id when you are amending — it is the merge key.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable lowercase kebab-case id, and the merge key.' },
            title: { type: 'string', description: 'One line, the headline.' },
            do: {
              type: 'string',
              description:
                'The procedure a person follows, in markdown: the commands, the URL, the clicks. Concrete ' +
                'steps, written for somebody who has not read the plan.',
            },
            expect: {
              type: 'string',
              description:
                'What they would see, and where — the row, the log line, the ref that is gone, the screen. ' +
                'A check that cannot say this is not a check.',
            },
            uses: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of declared resources this check needs. Names, never paths.',
            },
            covers: { type: 'array', items: { type: 'string' }, description: 'Part slugs this check exercises.' },
            fleetCandidate: {
              type: 'boolean',
              description:
                'Your nomination that an agent could run this rather than a person. A suggestion for whoever ' +
                'decides — it dispatches nothing, and you cannot know what logins this deployment has.',
            },
            why: { type: 'string', description: 'Why an agent could run it. Kept only with the nomination.' },
          },
          required: ['id', 'title', 'do', 'expect'],
        },
      },
      withdraw: {
        type: 'array',
        description:
          'Checks that should no longer be asked for, each with a reason. Withdrawing keeps the check on the ' +
          'record, greyed, with your reason on it — it does not delete it. Withdraw a check the goal no longer ' +
          'needs; do not withdraw one you could not get to pass.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            reason: { type: 'string', description: 'Why this is no longer worth checking.' },
          },
          required: ['id', 'reason'],
        },
      },
      resources: {
        type: 'array',
        description:
          'Files a check needs that the repository does not have: a seeded fixture, a reference screenshot, a ' +
          'dump of real data. Merged by name; nothing here removes one. Not the place for a login, an account ' +
          'or an environment — what a check needs to be runnable goes in its "do", where the person running it ' +
          'reads it. Set "provided": false for a file you cannot produce yourself, and the harness asks a ' +
          'person to put it on disk once the goal is delivered.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A file name, not a path.' },
            kind: { type: 'string', enum: ['fixture', 'access', 'reference', 'data'] },
            note: { type: 'string' },
            provided: { type: 'boolean', description: 'False is "I need this and cannot produce it".' },
          },
          required: ['name'],
        },
      },
    },
    required: ['note'],
  },
  handler: (args) => {
    const goal = validationAmendIssue(task.originRef);
    if (!goal.ok) return toolError(goal.error);
    const origin = issueOrigin(goal.issueNumber);
    const plan = deps.store.getPlanByOrigin(origin);
    if (!plan) {
      // `covers` names live part slugs, which is a property of the plan — and a
      // goal whose planner has not written one yet has no check set to amend
      // either. Said plainly rather than dressed up as a permission problem,
      // because it is neither the agent's fault nor something it can fix.
      return toolError(
        `Issue #${goal.issueNumber} has no plan yet, so it has no validation plan to amend. Say what should be ` +
          'checked in your conclusion instead.',
      );
    }
    const parsed = validateAmendment(args);
    // Nothing is written on a rejection, `plan_submit`'s rule: the caller retries
    // against an unchanged check set rather than a half-applied one.
    if (!parsed.ok) return toolError(`Amendment rejected: ${parsed.error}`);
    const amendment = parsed.amendment;

    // What `uses` may name is what the *plan* knows about once this amendment
    // lands, not just what the amendment declares — an agent adding a check
    // against a fixture the planner already declared has named a real resource.
    const resources = validationResourceInputs(amendment.resources);
    const known = [
      ...new Set([...deps.store.listValidationResources(origin).map((r) => r.name), ...resources.map((r) => r.name)]),
    ];
    // An amendment removes nothing, so the one thing that withdraws an ask here is
    // this amendment saying the resource is provided after all. Before the write,
    // because the ask is reached through the row it is about to update — and the
    // ask itself is filed by `ValidationAskDesk` once the goal is delivered, which
    // is when a check is something anybody can run.
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
      checks: validationCheckAmendments(
        amendment.checks,
        known,
        deps.store.listPlanParts(plan.id).map((p) => p.slug),
      ),
      withdraw: amendment.withdraw.map((w) => ({ id: w.id, reason: withdrawalReason(w.reason) })),
      resources,
      note: amendmentNote(amendment.note),
    });

    // The letters go back, because they are what a person types and what the
    // agent should use if it refers to a check in its conclusion.
    const named = (checks: ValidationCheck[]): string[] => checks.map((c) => `${c.letter}. ${c.id}`);
    // Said out loud rather than left to be inferred from a silent success: an
    // agent that reworded a check somebody had passed has *withdrawn that pass*,
    // and it is the one consequence of this call it did not ask for.
    const withdrew = result.reworded.filter((c) => c.revision?.state != null);
    return ok({
      amended: true,
      added: named(result.added),
      reworded: named(result.reworded),
      unchanged: result.unchanged,
      withdrawn: result.withdrawn,
      // Reported rather than swallowed: an id this goal has never held is almost
      // always a typo, and a silent success would leave the check standing.
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
