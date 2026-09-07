import { z } from 'zod';
import { parseItemRef } from '../findings.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const linkTicket: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'File the tracker item for the thing you were dispatched to file — a finding, or a bug an ' +
    'operator raised on a story — by handing over its title and body. The harness creates it: the ' +
    'type it is filed as, the labels it carries, who it is assigned to and any link back to the ' +
    'story are already settled, so you write the words and nothing else. If an existing item already ' +
    'covers it, pass its `ref` instead and that one is linked rather than a second filed. Only for a ' +
    'filing job: if you were not dispatched to file something, this is not your tool. Calling it is ' +
    'what completes the filing — until you do, the operator sees a filing whose item never appeared.',
  inputSchema: toolSchema(
    z.object({
      title: z
        .string()
        .describe(
          'The title of the item to file: one line naming the problem, for someone who was not ' +
            'there. Pass this with `body`, or pass `ref` instead if you found an item that already ' +
            'covers this.',
        )
        .optional(),
      body: z
        .string()
        .describe(
          'The body of the item to file, as Markdown. It goes into the tracker exactly as written — ' +
            'no harness wrapping, no summarising — so say what is wrong, where, and which parts you ' +
            'confirmed against the repository.',
        )
        .optional(),
      ref: z
        .string()
        .describe(
          'The **existing** item this duplicates, in the ref shape used everywhere else: ' +
            '"issue:314" for a GitHub issue or an Azure DevOps work item. Pass this instead of ' +
            'title/body when you decided not to file a second. A bare number is not accepted — say ' +
            'which.',
        )
        .optional(),
    }),
  ),
  handler: async (args) => {
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (ref && (title || body)) {
      return toolError(
        'link_ticket takes either `ref` (an existing item this duplicates) or `title` + `body` (the ' +
          'item to file), not both. Say which you meant.',
      );
    }
    if (!ref && !(title && body)) {
      return toolError(
        'link_ticket needs `title` and `body` to file the item, or `ref` if you decided it ' +
          'duplicates one that already exists.',
      );
    }

    const target = deps.agents.filingTarget(agent.id);
    if (!target.ok) return toolError(target.error);

    let ticketRef = ref;
    if (!ticketRef) {
      if (!deps.filing) {
        return toolError(
          'Ticket filing is not wired on this harness, so there is nothing to file into. Report what ' +
            'you found to the operator instead.',
        );
      }
      try {
        ticketRef = await deps.filing({
          title,
          body,
          bug: target.kind === 'bug',
          ...(target.storyNumber === null ? {} : { relatedTo: target.storyNumber }),
        });
      } catch (err) {
        return toolError(`The tracker refused the item: ${(err as Error).message}`);
      }
    } else {
      const parsed = parseItemRef(ticketRef);
      if (!parsed.ok) return toolError(`Ticket rejected: ${parsed.error}`);
      if (!parsed.ref) return toolError('link_ticket requires the ref of the ticket you created.');
      ticketRef = parsed.ref;
    }

    const result = deps.agents.linkTicket(agent.id, ticketRef);
    if (!result.ok) return toolError(result.error);
    return ok({
      linked: true,
      filed: ref === '',
      bug: { originRef: result.bug.originRef, status: result.bug.status, ticketRef: result.bug.ticketRef },
      note: 'Recorded against the story the operator raised it from. Your filing task is done.',
    });
  },
});
