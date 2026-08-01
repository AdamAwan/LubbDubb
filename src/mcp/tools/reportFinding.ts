import { FINDING_KIND_HELP, FINDING_KINDS, validateFinding } from '../findings.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const reportFinding: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'File something you noticed that is NOT your task — a duplicate, work blocked on something ' +
    'outside your reach, an unrelated problem you ran into. It lands in the harness and shows up ' +
    'in the cockpit for an operator, instead of being buried in a PR comment nobody reads. ' +
    'It does NOT create work or dispatch anyone: an operator decides whether it becomes a job. ' +
    'So report it and carry on with your own task — do not wait, and do not go fix it yourself.',
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
          'One or two sentences an operator can act on without asking you: what it is, where, ' +
          'and why it matters. Include the evidence — you are the only one who saw it.',
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
      note: 'Filed for an operator. It queues no work by itself — keep going with your own task.',
    });
  },
});
