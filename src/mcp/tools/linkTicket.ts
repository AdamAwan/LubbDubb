import { parseItemRef } from '../findings.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const linkTicket: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'File the tracker item for the thing you were dispatched to file — a finding, or a bug an ' +
    'operator raised on a story — by handing over its title and body. The harness creates it: the ' +
    'type it is filed as, the labels it carries, who it is assigned to and any link back to the ' +
    'story are already settled, so you write the words and nothing else. If an existing item already ' +
    'covers it, pass its `ref` instead and that one is linked rather than a second filed. Only for a ' +
    'filing job: if you were not dispatched to file something, this is not your tool. Calling it is ' +
    'what completes the filing — until you do, the operator sees a filing whose item never appeared.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'The title of the item to file: one line naming the problem, for someone who was not ' +
          'there. Pass this with `body`, or pass `ref` instead if you found an item that already ' +
          'covers this.',
      },
      body: {
        type: 'string',
        description:
          'The body of the item to file, as Markdown. It goes into the tracker exactly as written — ' +
          'no harness wrapping, no summarising — so say what is wrong, where, and which parts you ' +
          'confirmed against the repository.',
      },
      ref: {
        type: 'string',
        description:
          'The **existing** item this duplicates, in the ref shape used everywhere else: ' +
          '"issue:314" for a GitHub issue or an Azure DevOps work item. Pass this instead of ' +
          'title/body when you decided not to file a second. A bare number is not accepted — say ' +
          'which.',
      },
    },
  },
  handler: async (args) => {
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    // Two ways to finish a filing, and naming both is a contradiction rather than a
    // preference the harness gets to resolve: one says "this already exists", the
    // other says "create this". Refused rather than ranked.
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

    // Structural identity does the whole job here: the filing is resolved from the
    // credential (agent -> task -> its job -> the finding or bug that job was
    // created for), so there is no argument pointing at someone else's, and an
    // agent on any other kind of task simply has no filing to complete.
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
          // Both facts come from the credential, never from the agent: a bug is
          // created as the project's bug type and related back to the story it was
          // raised on, and that is exactly what a model used to have to remember.
          bug: target.kind === 'bug',
          ...(target.storyNumber === null ? {} : { relatedTo: target.storyNumber }),
        });
      } catch (err) {
        // Handed back rather than recorded and swallowed: the agent is mid-task and
        // is the one thing that can try again this turn.
        return toolError(`The tracker refused the item: ${(err as Error).message}`);
      }
    } else {
      // The same parser the intake uses for the item a claim is *about*, so the ref
      // a ticket is recorded under and the ref a claim names are the same
      // vocabulary — the cockpit links both through one `refUrls` lookup. Only the
      // agent-supplied arm needs it; what the harness filed is its own ref.
      const parsed = parseItemRef(ticketRef);
      if (!parsed.ok) return toolError(`Ticket rejected: ${parsed.error}`);
      if (!parsed.ref) return toolError('link_ticket requires the ref of the ticket you created.');
      ticketRef = parsed.ref;
    }

    const result = deps.agents.linkTicket(agent.id, ticketRef);
    if (!result.ok) return toolError(result.error);
    // Two things a filing job can be for, resolved from the credential the same
    // way: a finding an agent reported, or a bug an operator raised on a story.
    if (result.bug) {
      return ok({
        linked: true,
        filed: ref === '',
        bug: { originRef: result.bug.originRef, status: result.bug.status, ticketRef: result.bug.ticketRef },
        note: 'Recorded against the story the operator raised it from. Your filing task is done.',
      });
    }
    return ok({
      linked: true,
      filed: ref === '',
      claim: {
        id: result.graduation.factId,
        ticketRef: result.graduation.ticketRef,
      },
      // The claim leaves every prompt on this call, and the agent is told so: it is
      // the one thing about `link_ticket` that is not obvious from having filed a
      // ticket, and an agent that files a second one for the same claim would be
      // told the row was already answered rather than why.
      note:
        'Recorded against the claim, which is now in the tracker rather than in front of the fleet. ' +
        'Your filing task is done.',
    });
  },
});
