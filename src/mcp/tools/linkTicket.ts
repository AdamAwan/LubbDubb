import { parseFindingRef } from '../findings.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const linkTicket: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Report the tracker item you just created for the thing you were dispatched to file — a ' +
    'finding, or a work item for work the harness did that nothing accounted for. Only for a ' +
    'filing job: if you were not dispatched to file something, this is not your tool. Calling it ' +
    'is what completes the filing: until you do, the operator sees a filing whose item never ' +
    'appeared. Pass the ref of the item you created (or of the existing one you decided it ' +
    'duplicates).',
  inputSchema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description:
          'The ticket, in the ref shape used everywhere else: "issue:314" for a GitHub issue or an ' +
          'Azure DevOps work item, or "pr:42". A bare number is not accepted — say which.',
      },
    },
    required: ['ref'],
  },
  handler: (args) => {
    // The same parser `report_finding` uses for the item a finding is *about*,
    // so the ref a ticket is recorded under and the ref a finding names are the
    // same vocabulary — the cockpit links both through one `refUrls` lookup.
    const parsed = parseFindingRef(args.ref);
    if (!parsed.ok) return toolError(`Ticket rejected: ${parsed.error}`);
    if (!parsed.ref) return toolError('link_ticket requires the ref of the ticket you created.');
    // Structural identity again, and here it does the whole job: the finding is
    // resolved from the credential (agent -> task -> its job -> the finding that
    // job was created for), so there is no finding argument to point at someone
    // else's, and an agent on any other kind of task simply has no finding to
    // link.
    const result = deps.agents.linkTicket(agent.id, parsed.ref);
    if (!result.ok) return toolError(result.error);
    // Two things a filing job can be for, resolved from the credential the same
    // way: a finding an agent reported, or a work item for work the harness did
    // that nothing external accounted for.
    if (result.filing) {
      // Said back rather than left silent: the operator's images were keyed to the
      // job this agent is running, and they have just changed hands to the ticket
      // it created (issue #249). An agent that pasted the paths into the ticket
      // body should know they now belong to the goal, not to a job about to end.
      const moved =
        result.attachments > 0
          ? ` The ${result.attachments === 1 ? 'image the operator attached' : `${result.attachments} images the operator attached`} ` +
            `now belong to this ticket, and every agent dispatched for it will be handed ${result.attachments === 1 ? 'it' : 'them'}.`
          : '';
      return ok({
        linked: true,
        workItem: {
          targetRef: result.filing.targetRef,
          status: result.filing.status,
          ticketRef: result.filing.ticketRef,
        },
        attachmentsMoved: result.attachments,
        note: `Recorded against the work. It will hang off this item in the graph from the next pulse.${moved}`,
      });
    }
    return ok({
      linked: true,
      finding: { id: result.finding.id, status: result.finding.status, ticketRef: result.finding.ticketRef },
      note: 'Recorded against the finding. Your filing task is done.',
    });
  },
});
