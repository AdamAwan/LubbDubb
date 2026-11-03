import { z } from 'zod';
import { DISCUSSION_AUTHORS } from '../../discussions/discussionFile.js';
import { issueSubtreeNumber } from '../../issueOrigins.js';
import { issueForPr } from '../../pr/prIssue.js';
import type { Store } from '../../store/store.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/40-discussions.md#what-fleet-agents-write

const KINDS = ['note', 'idea', 'question'] as const;

function issueOfPr(store: Store, prNumber: number): number | null {
  const world = store.world.getWorldBaseline();
  const pr = world?.pullRequests.find((p) => p.number === prNumber);
  return pr === undefined ? null : (issueForPr(pr, world!.issues)?.number ?? null);
}

function issueOfOrigin(store: Store, originRef: string | null, standsIn: boolean = false): number | null {
  const issue = issueSubtreeNumber(originRef);
  if (issue !== null) return issue;
  const pr = /^pr:(\d+)(?::|$)/.exec(originRef ?? '')?.[1];
  if (pr !== undefined) return issueOfPr(store, Number(pr));
  const job = /^job:(.+)$/.exec(originRef ?? '')?.[1];
  if (job === undefined || standsIn) return null;
  return issueOfOrigin(store, store.jobs.getJob(job)?.originRef ?? null, true);
}

export const discussionAdd: ToolFactory = ({ deps, task, ok }) => ({
  description:
    "Add to the discussion of the story you are working on — the operator's running record of what has been " +
    'decided, suggested and asked about it, which every later planner, coder and reviewer on it is handed. ' +
    'A `question` is for something only the operator can answer (a product choice, an ambiguity in the ticket): ' +
    'it holds the next dispatch on this story until it is answered, so ask rather than build on a guess — but ' +
    'answer what the code can answer yourself. An `idea` is a suggestion the operator may accept or park. A ' +
    '`note` is anything a later agent on this story should know. Decisions are the operator’s and cannot be ' +
    'written here. It writes to your own story only, and carries on your current task — it asks nothing of anyone now.',
  inputSchema: toolSchema(
    z.object({
      kind: z.enum(KINDS).describe('note, idea or question.'),
      body: z.string().describe('The entry, in plain Markdown. One point per entry.'),
    }),
  ),
  handler: (args) => {
    const kind = args.kind;
    if (kind === 'decision') {
      return toolError(
        "Decisions are the operator's alone. Add it as a `question` asking them to decide, or as an `idea` proposing it.",
      );
    }
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      return toolError(`kind must be one of ${KINDS.join(', ')}.`);
    }
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (body === '') return toolError('body is required: the note, idea or question, in plain words.');
    const discussions = deps.discussions;
    if (discussions === undefined || !discussions.files.enabled) {
      return toolError('Discussions are off on this deployment (discussionsDir is not set); nothing was written.');
    }
    const issueNumber = issueOfOrigin(deps.store, task.originRef);
    if (issueNumber === null) {
      return toolError(
        `A discussion belongs to one story or feature, and this task's origin is ${task.originRef ?? '(none)'}, ` +
          'which is neither. Use scratch_append or note_progress instead.',
      );
    }
    const written = discussions.files.add(discussions.subject(issueNumber), {
      kind: kind as (typeof KINDS)[number],
      body,
      author: DISCUSSION_AUTHORS.agent(task.rule ?? 'agent', task.id),
    });
    if (!written.ok) return toolError(written.error);
    return ok({
      added: true,
      issue: issueNumber,
      id: written.entry.id,
      path: written.path,
      note:
        kind === 'question'
          ? 'Recorded. It holds the next dispatch on this story until the operator answers it; your own task carries on.'
          : 'Recorded. Every later agent on this story is handed it.',
    });
  },
});
