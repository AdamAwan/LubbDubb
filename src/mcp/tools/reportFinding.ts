import { FINDING_KIND_HELP, FINDING_KINDS, validateFinding } from '../findings.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const reportFinding: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'File something you noticed that is NOT your task — a duplicate, work blocked on something ' +
    'outside your reach, an unrelated problem you ran into. It lands in the harness and shows up ' +
    'in the cockpit for an operator, instead of being buried in a PR comment nobody reads. ' +
    'It does NOT create work or dispatch anyone: an operator decides whether it becomes a job. ' +
    'So report it and carry on with your own task — do not wait, and do not go fix it yourself. ' +
    'Report it plainly either way: if another agent already filed the same claim, yours merges ' +
    'into theirs rather than filing a second copy.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...FINDING_KINDS],
        description: FINDING_KINDS.map((k) => `${k}: ${FINDING_KIND_HELP[k]}`).join('. '),
      },
      summary: {
        type: 'string',
        description:
          'The claim, on ONE line under 160 characters — what it is and why it matters. No ' +
          'newlines: an operator scans this in a list. Everything else goes in where and detail.',
      },
      where: {
        type: 'string',
        description:
          'Where you saw it: file and line, package, service, endpoint — whatever locates it. ' +
          'Omit it when the summary already says, or when there is nowhere to point.',
      },
      detail: {
        type: 'string',
        description:
          'The evidence, in markdown: the error, how to reproduce it, your reasoning. Put ' +
          'stack traces and command output in a fenced code block. You are the only one who ' +
          'saw it — but keep it out of the summary. Omit it when the claim stands on its own.',
      },
      ref: {
        type: 'string',
        description:
          'The item this is about, if there is one: "issue:41", "pr:42". For a ' +
          'duplicate, the item you believe it duplicates. Omit it when the finding is about ' +
          'something the harness does not track.',
      },
    },
    required: ['kind', 'summary'],
  },
  handler: (args) => {
    // Validated at the boundary, with the reason handed back — the whole point
    // of a tool over a PR comment is that a malformed report is a fixable error
    // in this turn rather than a paragraph nobody parses.
    const parsed = validateFinding(args);
    if (!parsed.ok) return toolError(`Finding rejected: ${parsed.error}`);
    // Attribution is the credential's, never an argument's. `world_read` could
    // relax the no-cross-origin rule because a read forges nothing and mutates
    // nothing; this is a *write* that puts words in an agent's mouth in front of
    // an operator. An agent that could name the reporter could file a finding as
    // another agent — and a finding is read as testimony about work its author
    // actually did, so a forged one is worse than no channel at all.
    const result = deps.agents.recordFinding(agent.id, parsed.input);
    if (!result.ok) return toolError(result.error);
    return ok({
      recorded: true,
      finding: {
        id: result.finding.id,
        kind: result.finding.kind,
        ref: result.finding.ref,
        status: result.finding.status,
      },
      // Said again in the response, not only in the description: an agent that
      // believes reporting a bug scheduled its fix will stop watching for it.
      // And an agent whose report merged is told so rather than left to conclude
      // from a returned id that it filed something new.
      note: result.created
        ? 'Filed for an operator. It queues no work by itself — keep going with your own task.'
        : 'This claim was already on the operator’s list, so your report merged into the standing ' +
          'finding rather than filing a second one. Nothing more to do — keep going with your own task.',
    });
  },
});
