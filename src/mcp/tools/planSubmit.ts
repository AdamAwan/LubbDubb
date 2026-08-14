import { validatePlanDocument } from '../../plans/planDocument.js';
import { ingestPlanDocument, overriddenSingleMessage } from '../../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../../plans/planning.js';
import type { Task } from '../../types.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The tool's origin fence, declared rather than buried: only an agent dispatched
 * to *plan* an issue may submit a decomposition for it.
 *
 * This is the one fence the tool layer owns. The others — `conclusionOrigin`,
 * `partConclusionOrigin`, `padOriginFor`, `retroSubmitOrigin`, `assessmentOrigin`,
 * `assayerOrigin` — are asked at the fleet seam because each *resolves* something
 * out of the store as it refuses (the part, the pad, the issue), so a copy here
 * would be a second answer to a question already answered next to the write it
 * guards. This one resolves nothing but the issue number, which is pure.
 */
function plannerIssue(task: Task): { ok: true; number: number } | { ok: false; error: string } {
  const number = planOriginIssue(task.originRef);
  if (number === null) {
    return {
      ok: false,
      error:
        `plan_submit is only available to a planning agent. This task's origin is ` +
        `${task.originRef ?? '(none)'}, which is not a planning origin.`,
    };
  }
  return { ok: true, number };
}

export const planSubmit: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Submit your decomposition verdict for the issue you were dispatched to plan. ' +
    'Use verdict "single" when one pull request is the right shape, or "parts" with an ordered ' +
    'list of independently reviewable pieces. Validated immediately: on rejection you get the ' +
    'reason back and can fix and resubmit in this same turn. Replaces writing .lubbdubb/plan.json.',
  inputSchema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['single', 'parts'], description: 'One PR, or several.' },
      diagnosis: {
        type: 'string',
        description:
          'What is actually wrong, in the code — the root cause you found, not a restatement of the ' +
          'issue. Omit only when the work is not a defect and there is nothing to diagnose.',
      },
      approach: {
        type: 'string',
        description:
          'What you are going to do about it, in two or three sentences. This is the summary the ' +
          'operator approves on, so write the fix, not the shape of the pull requests.',
      },
      reason: { type: 'string', description: 'Why this shape — one or two sentences. Not the fix; the split.' },
      risks: { type: 'string', description: 'What could go wrong with this split.' },
      outOfScope: { type: 'string', description: 'What you deliberately left out, and why.' },
      alternatives: {
        type: 'string',
        description:
          'What you considered and rejected, and why each was rejected. Name real options you weighed, ' +
          'not strawmen — this is the field an operator reads to decide whether you looked around before ' +
          'you chose. An approach with no alternatives is one nobody can disagree with usefully.',
      },
      openQuestions: {
        type: 'string',
        description:
          'What you are least sure about: the assumption you would most like argued with, and what would ' +
          'change your mind. This is the agenda if the operator opens a discussion, so be specific about ' +
          'the decision rather than modest about the plan.',
      },
      verification: {
        type: 'string',
        description:
          'How anyone will know the whole thing worked, once every part has landed. Not per part — that is ' +
          '"acceptance" — and not the test suite unless the test suite genuinely settles it.',
      },
      evidence: {
        type: 'array',
        description:
          'Where in the code the diagnosis comes from. Cite the places you actually read; a root cause with ' +
          'no citation cannot be checked, and a reader who cannot check it has to take it on trust.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repository-relative path.' },
            line: { type: 'number', description: 'Optional. Omit when the claim is about the file.' },
            note: { type: 'string', description: 'What the reader is meant to see there.' },
          },
          required: ['path'],
        },
      },
      document: {
        type: 'string',
        description:
          'The full write-up in markdown — the version a human reads before approving. The fields above are ' +
          'the summary; this is the argument. Do not repeat them: cover how you got to the diagnosis, what ' +
          'the code actually looked like, and what a reviewer of the finished work should check.',
      },
      parts: {
        type: 'array',
        description: 'Required when verdict is "parts"; ignored otherwise.',
        items: {
          type: 'object',
          properties: {
            slug: {
              type: 'string',
              description: 'Stable lowercase kebab-case id. Keep it identical across a replan.',
            },
            title: { type: 'string' },
            scope: { type: 'string', description: 'The files or areas this part owns, in a sentence.' },
            touches: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The same ownership claim as repository paths — a directory or a file per entry. What this ' +
                'part is allowed to write. Declare it even when "scope" already says so in prose: this is ' +
                'the form that gets compared to what the part actually wrote.',
            },
            size: {
              type: 'string',
              enum: ['s', 'm', 'l'],
              description:
                'How big this part is to *review*, not how long it takes. Three parts is not a cost; three ' +
                'large ones is, and that is the thing an operator is agreeing to.',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Sibling slugs this part needs first. One means it stacks on that part and starts once ' +
                'that part has pushed. Several means the lanes rejoin: it starts only once all of them ' +
                'have merged, and is cut from the integration branch.',
            },
            rationale: { type: 'string', description: 'Why this is its own PR rather than folded into a sibling.' },
            acceptance: { type: 'string', description: 'What makes this part done.' },
          },
          required: ['slug', 'title', 'scope'],
        },
      },
      validation: {
        type: 'object',
        description:
          'How anyone checks the goal was met, as steps rather than as a paragraph — "verification" is the ' +
          'sentence, this is the procedure. Declare it whenever there is something a person or an agent could ' +
          'actually run against the delivered goal, on either verdict: one pull request needs validating as much ' +
          'as a decomposed one.',
        properties: {
          resources: {
            type: 'array',
            description:
              'Things a check needs that are not in the repository: a seeded fixture, a reference screenshot, ' +
              'an account. Name them; never write paths. "provided": false says you need something you cannot ' +
              'produce, and files an ask for it.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'A file name, not a path.' },
                kind: { type: 'string', enum: ['fixture', 'access', 'reference', 'data'] },
                note: { type: 'string', description: 'What it is, and what a check does with it.' },
                provided: { type: 'boolean', description: 'False is "I need this and cannot produce it".' },
              },
              required: ['name'],
            },
          },
          checks: {
            type: 'array',
            description:
              'The checks themselves. Who runs each one is not yours to say — the fleet has no browser, no ' +
              'interactive login and no account on whatever environment this deployment tests against, and you ' +
              'cannot know that from the repository. A check carrying an "actor" is refused.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable lowercase kebab-case id, and the merge key on a replan.' },
                title: { type: 'string', description: 'One line, the headline.' },
                do: {
                  type: 'string',
                  description: 'The procedure, in markdown, for somebody who has not read your plan.',
                },
                expect: {
                  type: 'string',
                  description: 'What a pass looks like. A check that cannot say this is not a check.',
                },
                uses: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Names of resources declared above that this check needs. Names, never paths.',
                },
                covers: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Part slugs this check exercises, so the sheet can show which parts nothing checks. ' +
                    'Validation is per goal, so a check spanning several parts is normal.',
                },
                fleetCandidate: {
                  type: 'boolean',
                  description:
                    'Your nomination that an agent could run this rather than a person. A suggestion for ' +
                    'whoever decides — it dispatches nothing.',
                },
                why: { type: 'string', description: 'Why an agent could run it. Kept only with the nomination.' },
              },
              required: ['id', 'title', 'do', 'expect'],
            },
          },
        },
      },
    },
    required: ['verdict', 'reason'],
  },
  handler: (args) => {
    const planner = plannerIssue(task);
    if (!planner.ok) return toolError(planner.error);
    // Same schema as the file path, so the two transports accept and reject
    // exactly the same documents — the difference is only that this one can
    // hand the reason back instead of burning an attempt to discover it.
    const parsed = validatePlanDocument({
      version: 1,
      verdict: args.verdict,
      reason: args.reason,
      diagnosis: args.diagnosis,
      approach: args.approach,
      risks: args.risks,
      outOfScope: args.outOfScope,
      alternatives: args.alternatives,
      openQuestions: args.openQuestions,
      verification: args.verification,
      evidence: args.evidence ?? [],
      document: args.document,
      parts: args.parts ?? [],
      // Passed through rather than defaulted to an empty block: `ValidationSchema`
      // is optional precisely so that *absent* means "leave the existing checks
      // alone", and `{checks: []}` would read to `ingestPlanDocument` as a planner
      // withdrawing every check somebody is halfway through running.
      validation: args.validation,
    });
    if (!parsed.ok) {
      // Nothing is written on a rejection: the caller retries against an
      // unchanged plan graph rather than a half-applied one.
      return toolError(`Plan rejected: ${parsed.error}`);
    }
    const result = ingestPlanDocument(deps.store, {
      doc: parsed.document,
      originRef: issueOrigin(planner.number),
      title: task.originTitle ?? task.title,
      requireApproval: deps.requirePlanApproval,
    });
    if (result.overriddenSingle) {
      const message = overriddenSingleMessage(issueOrigin(planner.number), result.overriddenSingle.liveParts);
      deps.errors?.record({ source: 'agent', message: `Agent ${agent.id}: ${message}` });
      // Told to the agent too, not just the operator — it asked for something
      // the world no longer allows and would otherwise assume it landed.
      return ok({ accepted: true, status: result.status, retired: result.retired, warning: message });
    }
    // Said out loud rather than left to be read off the status string: a
    // planner that thinks its parts are being worked would otherwise sit
    // waiting for siblings that will not start until a human clicks accept.
    const awaiting =
      result.status === 'awaiting_approval'
        ? { awaitingApproval: 'The plan is recorded, but nothing is scheduled until an operator approves it.' }
        : {};
    return ok({ accepted: true, status: result.status, retired: result.retired, ...awaiting });
  },
});
