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
      document: {
        type: 'string',
        description:
          'The full write-up in markdown — the version a human reads before approving. ' +
          'Cover why the work is shaped this way, what you considered and rejected, and ' +
          'anything you are unsure about. This is what the operator reads; write it for them.',
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
            scope: { type: 'string', description: 'The files or areas this part owns.' },
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
      document: args.document,
      parts: args.parts ?? [],
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
