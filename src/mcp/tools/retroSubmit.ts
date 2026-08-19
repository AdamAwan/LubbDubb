import { validateRetrospective } from '../../retro/retro.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The retrospective, and the lessons it proposes (issue #355 phase 2).
 *
 * The lessons are a field on this tool rather than a tool of their own, and that
 * is the load-bearing choice: it keeps the submission atomic — no run files
 * lessons but no write-up — and it keeps `src/mcp/names.ts`' three-way agreement
 * untouched, since a new tool name would need a new `mcp__lubbdubb__*` grant to
 * go with it.
 *
 * **The discriminator lives in the description, not only in the prompt.** The
 * `issue-retro` template is operator-overridable, so a deployment running an
 * override written before this change would otherwise dispatch an agent that
 * never hears the lesson store exists — the customised deployments losing the
 * feature silently, which is the failure mode the append-don't-interpolate rule
 * exists for. A tool description always arrives.
 */
export const retroSubmit: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Submit the retrospective for the issue you were dispatched to write up. Two audiences, one ' +
    'document: **what shipped** — the pull requests, what each part decided, what was concluded out ' +
    'of scope or needed no code, anything still outstanding — and **how the run went**, for the ' +
    'operator: where agents were spent and why, which gates or escalations cost time, what surprised ' +
    'the agents, what you would change about the process. You have the scratchpad the working agents ' +
    'left and the record the harness kept; reconcile them and say where they disagree. This schedules ' +
    'nothing, closes nothing and is posted nowhere — a human reads it and decides what to change.\n\n' +
    'You may also propose **lessons**: the few things this run taught about *working this repository* ' +
    'that the next goal would otherwise pay to learn again. One question decides whether something is ' +
    'a lesson: does it describe **the repository**, or **working the repository**?\n\n' +
    '- Working the repository — "the suite needs the web bundle built first", "this subsystem\'s tests ' +
    'sit at an odd seam", "a ticket naming only a symptom is under-specified for a planner every ' +
    'time" → a lesson here.\n' +
    '- A fact about the code — a seam, an invariant, a second place a thing must be registered → ' +
    'report_finding with kind "docs". Promoted, it becomes a pull request against the repository\'s ' +
    'own documentation, which is where the repository keeps its own knowledge. Not a lesson: a ' +
    "lesson is ours and has no business in someone else's tree.\n" +
    '- A defect you noticed in passing → report_finding with kind "out_of_scope". Not a lesson.\n' +
    '- Something true only of this goal → the scratchpad, where it dies with the goal, correctly. Not ' +
    'a lesson.\n\n' +
    'A lesson lands as a *proposal* and reaches no agent until an operator vouches for it, so file the ' +
    'one or two a reader would thank you for rather than everything you noticed. A run that taught ' +
    'nothing general is the ordinary case: submit no lessons and the retrospective is complete.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'One or two sentences: what was delivered, and the one thing about this run worth knowing. ' +
          'This is what an operator sees before deciding to open the document.',
      },
      document: { type: 'string', description: 'The write-up itself, in markdown.' },
      lessons: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional. What this run taught about working this repository, one claim per entry, a line ' +
          'or two each. Each is stored against this issue and dated, and waits for an operator to ' +
          'promote or discard it. Omit it when the run taught nothing that outlives the goal.',
      },
    },
    required: ['summary', 'document'],
  },
  handler: (args) => {
    const parsed = validateRetrospective(args);
    if (!parsed.ok) return toolError(`Retrospective rejected: ${parsed.error}`);
    const result = deps.agents.recordRetrospective(agent.id, parsed.summary, parsed.document, parsed.lessons);
    if (!result.ok) return toolError(result.error);
    return ok({
      filed: true,
      issue: result.issueOrigin,
      trimmed: parsed.trimmed,
      lessonsFiled: result.lessonsFiled,
      // Named rather than silent: a lesson that did not land is one an operator
      // will never be asked about, and an agent that thinks it filed eight has no
      // way to find out otherwise. The write-up itself is never at risk — a
      // lesson that does not fit is dropped, never the submission.
      lessonsDropped: parsed.lessonsDropped,
      note:
        'Recorded. It is read in the cockpit on the goal that produced it; nothing is posted to the ' +
        'tracker, nothing is closed, and nothing is scheduled from it. Any lessons are proposals an ' +
        'operator rules on — they reach no agent on your say-so.',
    });
  },
});
