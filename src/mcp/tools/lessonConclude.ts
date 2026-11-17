import { z } from 'zod';
import { toolError } from '../protocol.js';
import { toolSchema } from '../schema.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md, docs/spec/41-repo-lessons.md#the-outcome

const LessonConcludeArgs = z.object({
  outcome: z
    .enum(['pull_request', 'ticket', 'nothing'])
    .describe(
      'pull_request: you made a small fix on your branch, committed and pushed it, and the harness opens the pull ' +
        'request. ticket: the fix is too large to make here, and the harness files it for the operator to decide on. ' +
        'nothing: no change to the repository is right — a matter of taste is not a rule.',
    ),
  fix: z
    .enum(['code', 'guard', 'contradiction', 'note'])
    .optional()
    .describe(
      'Required unless the outcome is nothing. code: the cause removed in the code. guard: a lint rule, type or ' +
        'test that fails when the miss is made. contradiction: code and docs disagreed and one was corrected. ' +
        'note: a line in the nearest CLAUDE.md or document.',
    ),
  title: z
    .string()
    .optional()
    .describe(
      'Required for a pull request or a ticket: what the change does, plainly. Name no pull request or work item in ' +
        'it — the harness cites every one in the body as a link.',
    ),
  summary: z
    .string()
    .optional()
    .describe(
      'What you changed, or for a ticket the change you would make and where. Kept on the lesson record and, for a ' +
        'ticket, written into it; a pull request’s description is the evidence the harness renders, not this.',
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'Why this fix and not the ones above it in the order — and for nothing, why nothing. Required for nothing.',
    ),
});

export const lessonConclude: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Finish a repo lesson. Call it once, at the end: it is the only way a lesson pull request is opened, a lesson ' +
    'ticket filed, or a lesson settled with nothing. There is no body argument: the harness writes the pull ' +
    'request’s description from the evidence you were handed, links every pull request behind it, labels it as a ' +
    'lesson and watches it. For a pull request, commit and push your branch first — the harness never pushes.',
  inputSchema: toolSchema(LessonConcludeArgs),
  handler: async (args) => {
    const desk = deps.lessons?.();
    if (desk === undefined) return toolError('Repo lessons are not wired on this harness.');
    const parsed = LessonConcludeArgs.safeParse(args);
    if (!parsed.success) return toolError(`lesson_conclude rejected: ${parsed.error.message}`);
    const { outcome, fix, title, summary, reason } = parsed.data;
    const result = await desk.conclude(task, {
      outcome,
      fix: fix ?? null,
      title: title ?? '',
      summary: summary ?? '',
      reason: reason ?? '',
    });
    if (!result.ok) return toolError(`lesson_conclude rejected: ${result.error}`);
    if (result.outcome === 'pull_request')
      return ok({
        concluded: true,
        pullRequest: result.prNumber,
        branch: result.branch,
        note: 'Opened, labelled and watched. CI and review on it are answered like any of the fleet’s pull requests. You are done.',
      });
    if (result.outcome === 'ticket')
      return ok({
        concluded: true,
        ticket: result.ticketRef,
        note: 'Filed for the operator to decide on. You are done.',
      });
    return ok({ concluded: true, note: 'Settled with nothing. You are done.' });
  },
});
