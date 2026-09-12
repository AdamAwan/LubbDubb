import { z } from 'zod';
import { issueSubtreeNumber } from '../issueOrigins.js';
import { toolSchema } from './schema.js';
import { expiresAt } from '../ejection/policy.js';
import type { Ejection } from '../types.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/35-ejection.md

const TRANSCRIPT_TAIL = 4_000;

function resolve(
  deps: DesktopToolDeps,
  args: Record<string, unknown>,
): { ok: true; held: Ejection } | { ok: false; error: string } {
  const live = deps.store.ejections.liveEjections();
  const id = typeof args.ejection === 'string' ? args.ejection.trim() : '';
  if (id !== '') {
    const held = deps.store.ejections.getEjection(id);
    if (!held) return { ok: false, error: `No ejection "${id}".` };
    return { ok: true, held };
  }
  const issue = typeof args.issue === 'number' ? args.issue : null;
  if (issue !== null) {
    const matches = live.filter((e) => issueSubtreeNumber(e.originRef) === issue);
    const only = matches[0];
    if (matches.length === 1 && only !== undefined) return { ok: true, held: only };
    if (matches.length === 0)
      return {
        ok: false,
        error:
          `Nothing on #${issue} is held by an ejection. ` +
          (live.length === 0
            ? 'Nothing is: the fleet has all of its work.'
            : `What is held: ${live.map((e) => `${e.originRef} (${e.id})`).join(', ')}.`),
      };
    return {
      ok: false,
      error:
        `#${issue} has ${matches.length} pieces of work held. Name one with \`ejection\`: ` +
        `${matches.map((e) => `${e.originRef} (${e.id})`).join(', ')}.`,
    };
  }
  return { ok: false, error: 'Give either an `issue` number or an `ejection` id.' };
}

function describe(deps: DesktopToolDeps, held: Ejection): Record<string, unknown> {
  const policy = deps.briefConfig().ejection;
  return {
    ejection: held.id,
    origin: held.originRef,
    issue: issueSubtreeNumber(held.originRef),
    branch: held.branch,
    worktree: held.worktreePath,
    reason: held.reason,
    ejectedAt: held.ejectedAt,
    expiresAt: expiresAt(held.ejectedAt, policy),
    lastSeenAt: held.lastSeenAt,
    lastNote: held.lastNote,
    settledAt: held.settledAt,
    outcome: held.outcome,
    resume: held.sessionId === null ? null : `claude --resume ${held.sessionId}`,
  };
}

const ejectionRead: DesktopToolFactory = (deps) => ({
  description:
    'Read a piece of work an operator has taken off the fleet — why they stopped the agent, what the agent had ' +
    'been sent to do, the tail of its transcript, and how long the hold stands. Call this first, before you ' +
    'touch the branch: the operator ejected for a reason and it is the whole brief.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 412.').optional(),
      ejection: z.string().describe('Optional. The ejection id, where a goal has more than one held.').optional(),
    }),
  ),
  handler: (args) => {
    const found = resolve(deps, args);
    if (!found.ok) return toolError(found.error);
    const held = found.held;
    deps.store.ejections.noteEjection(held.id, null);
    const task = deps.store.tasks.getTask(held.taskId);
    const agent = deps.store.agents.getAgent(held.agentId);
    const transcript = deps.store.transcripts.getTranscript(held.agentId);
    return toolJson({
      ...describe(deps, held),
      brief: task === null ? null : { title: task.title, prompt: task.prompt, dispatchReason: task.dispatchReason },
      agent:
        agent === null
          ? null
          : { id: agent.id, lastProgress: agent.note, startedAt: agent.startedAt, endedAt: agent.endedAt },
      transcriptTail: transcript.slice(-TRANSCRIPT_TAIL),
      transcriptChars: transcript.length,
      next: READ_NEXT,
    });
  },
});

const READ_NEXT =
  'Say plainly what the agent had done and where the operator thinks it went wrong, then follow their lead. ' +
  'Do not carry the work on by yourself: an ejection is a person taking over, and a session that keeps going ' +
  'regardless has reproduced the thing they ejected. The goal and this worktree are held for them until ' +
  'ejection_settle, so nothing is racing you.';

const ejectionNote: DesktopToolFactory = (deps) => ({
  description:
    'Say in one line what is being done with an ejected piece of work right now. It is what the fleet view ' +
    'shows beside the held slot, so everybody else can tell a hold somebody is working from a hold somebody ' +
    'forgot. Worth a call after a commit and on a change of direction; it changes nothing about the hold.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 412.').optional(),
      ejection: z.string().describe('Optional. The ejection id, where a goal has more than one held.').optional(),
      note: z.string().describe('One line, in the present tense — "reverting the store extraction".'),
    }),
  ),
  handler: (args) => {
    const found = resolve(deps, args);
    if (!found.ok) return toolError(found.error);
    const note = typeof args.note === 'string' ? args.note.trim() : '';
    if (note === '') return toolError('note required — one line about what is happening to this work now.');
    if (found.held.settledAt !== null)
      return toolError(`That ejection was settled as "${found.held.outcome}"; there is no hold left to report on.`);
    deps.store.ejections.noteEjection(found.held.id, note);
    return toolJson({ ejection: found.held.id, note, means: 'the held slot now says this on the fleet view.' });
  },
});

const SETTLE_MEANS: Record<string, string> = {
  handed_back:
    'the hold is released and nothing else is written. The rule that produced this work proposes it again on ' +
    'the next pulse, reading the branch as it now stands.',
  requeued:
    'a job carrying your note is queued and stands in for the ejected origin until it runs, so nothing races it.',
  delivered:
    "the hold is released and the pull-request rules take it from here — this goal's next decision is a review, " +
    'not a fresh dispatch.',
};

const ejectionSettle: DesktopToolFactory = (deps) => ({
  description:
    'Give an ejected piece of work back to the fleet. Every ejection ends here: until it does, the goal is not ' +
    'staffed and its worktree is out of the pool. Ask the operator which of the three it is — the answer is ' +
    'theirs, not yours.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 412.').optional(),
      ejection: z.string().describe('Optional. The ejection id, where a goal has more than one held.').optional(),
      outcome: z
        .enum(['handed_back', 'requeued', 'delivered'])
        .describe(
          '"handed_back" is "never mind, the agent was right" — the fleet picks the work up again from scratch. ' +
            '"requeued" is "I fixed the direction, you finish" and needs a note saying what you changed. ' +
            '"delivered" is "it is a pull request now".',
        ),
      note: z
        .string()
        .describe(
          'Required for "requeued": the preamble the fresh agent reads. Optional otherwise, and kept as the ' +
            'record of what happened.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const found = resolve(deps, args);
    if (!found.ok) return toolError(found.error);
    const outcome = args.outcome;
    if (outcome !== 'handed_back' && outcome !== 'requeued' && outcome !== 'delivered')
      return toolError('outcome must be handed_back, requeued or delivered.');
    const note = typeof args.note === 'string' ? args.note : null;
    const result = deps.ejections().settle(found.held.id, outcome, note);
    if (!result.ok) return toolError(result.error);
    return toolJson({
      ejection: result.ejection.id,
      outcome,
      job: result.jobId,
      means: SETTLE_MEANS[outcome],
    });
  },
});

export const DESKTOP_EJECTION_TOOLS = {
  ejection_read: ejectionRead,
  ejection_note: ejectionNote,
  ejection_settle: ejectionSettle,
};
