import { submitBrief } from '../jobs/brief.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

/**
 * The two verbs that reach the fleet itself: putting work in, and driving an
 * agent that is already running.
 *
 * These are the ones that make the channel a way to *run* the harness rather
 * than a way to watch it, and they are the ones an operator most often wants at
 * a keyboard they do not have — a brief typed from a phone, an agent that has
 * been sat at a prompt for an hour.
 *
 * **`job_create` is still not a dispatch.** A code brief on a deployment with a
 * tracker is **filed as a watched ticket** and enters the planning funnel like
 * any other issue; the harness decides whether and when to work it. That is not
 * a fence drawn for this channel — it is what `POST /api/jobs` has done since
 * issue #198, and it is shared code (`src/jobs/brief.ts`) rather than a second
 * account of it. A desk brief, and a code brief where nothing is configured to
 * file, do queue directly.
 *
 * **`agent_control` is the one place this channel touches a live process.** Each
 * verb is `AgentManager`'s own, reached exactly as the cockpit's button reaches
 * it, and every one of them refuses an agent that is not live rather than
 * reporting a success against a dead row.
 */

/** What `agent_control` will do, and the sentence each one is worth saying back. */
const AGENT_ACTIONS = {
  respond: 'typed into the session; the agent carries on from it',
  interrupt: 'sent Ctrl-C; the agent stops what it is doing and stays at its prompt',
  complete: 'marked finished, as the operator saying the work is done',
  kill: 'stopped, and its process subtree reaped with it',
  extend_stall: 'given more time before its stall park settles itself',
  resume: 'taken out of its usage-limit park and re-opened',
} as const;

type AgentAction = keyof typeof AGENT_ACTIONS;

export const jobCreate: DesktopToolFactory = (deps) => ({
  description:
    'Put a piece of work to the harness in your own words. A `code` brief on a deployment with a tracker is ' +
    'filed as a watched ticket and goes through the same planning funnel as any other issue — it is not coded ' +
    'straight off this prompt, and the harness decides when to work it. A `desk` brief queues directly for an ' +
    'agent that reads and writes rather than one that changes code.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          "What is wanted, in the operator's own words. This is the ticket body or the agent's whole brief, so " +
          'write what somebody picking it up cold would need.',
      },
      title: { type: 'string', description: "Optional. Defaults to the prompt's first line." },
      kind: {
        type: 'string',
        enum: ['code', 'desk'],
        description:
          '"code" is work on the repository, which is filed as a ticket where a tracker is configured. "desk" ' +
          'is reading, research or writing — it never touches a branch. Defaults to "code".',
      },
      branch: {
        type: 'string',
        description:
          'Only meaningful for a code brief that queues directly (no tracker configured); ignored otherwise. ' +
          'Refused if a live task already holds it.',
      },
    },
    required: ['prompt'],
  },
  handler: async (args) => {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return toolError('prompt required — say what the work actually is.');
    const kind = args.kind === 'desk' ? 'desk' : 'code';
    if (args.kind !== undefined && args.kind !== 'code' && args.kind !== 'desk')
      return toolError('kind must be "code" or "desk".');
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;
    const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : null;

    const outcome = await submitBrief(
      {
        store: deps.store,
        config: deps.briefConfig(),
        filing: deps.filing(),
        errors: deps.errors ?? { record: () => ({}) as never },
        renderTicketBody: (vars) => deps.renderTicketBody(vars),
      },
      { prompt, title, kind, branch },
    );
    if (!outcome.ok) return toolError(outcome.error);
    await deps.runCycle();
    if (outcome.kind === 'ticket')
      return toolJson({
        filed: outcome.ticketRef,
        // Said rather than implied: a session told only "created" would reasonably
        // report back that the work has started, and it has not.
        means:
          'a ticket was filed carrying the watch tag, so the harness will appraise it, plan it and work its ' +
          'parts in its own order. Nothing has been dispatched by this call. Read fleet_status to see where it ' +
          'sits in the queue.',
      });
    return toolJson({
      job: { id: outcome.job.id, title: outcome.job.title, kind: outcome.job.kind, status: outcome.job.status },
      means:
        'the brief is queued and will take the next free slot ahead of world-driven work. It is not running ' +
        'yet; queue_control can drop it while it is still queued.',
    });
  },
});

export const agentControl: DesktopToolFactory = (deps) => ({
  description:
    'Act on one running agent: type an answer into it, interrupt it, mark it finished, stop it, buy it more ' +
    'time before a stall park settles, or take it out of a usage-limit park. Read it first with agent_read — ' +
    'these act on a live process, and stopping one loses whatever it had not written down.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'The agent id, from fleet_status or agent_read.' },
      action: {
        type: 'string',
        enum: Object.keys(AGENT_ACTIONS),
        description:
          '"respond" types `text` into the session. "interrupt" sends Ctrl-C. "complete" records the work as ' +
          'finished. "kill" stops it and reaps its process subtree. "extend_stall" buys time on a stall park. ' +
          '"resume" re-opens a session parked on a usage limit.',
      },
      text: { type: 'string', description: 'Required for "respond": what the agent reads.' },
    },
    required: ['agentId', 'action'],
  },
  handler: (args) => {
    const id = typeof args.agentId === 'string' ? args.agentId.trim() : '';
    if (!id) return toolError('agentId required — take it from fleet_status.');
    const action = args.action as AgentAction;
    if (typeof action !== 'string' || !(action in AGENT_ACTIONS))
      return toolError(`action must be one of: ${Object.keys(AGENT_ACTIONS).join(', ')}.`);
    // Named before anything is attempted: an id that is not an agent at all and an
    // agent that has already ended are different answers, and "not live" alone
    // would read as the second on a typo.
    const agent = deps.store.getAgent(id);
    if (!agent) return toolError(`No agent "${id}". Call fleet_status for the ones that are running.`);

    const fleet = deps.agents();
    if (action === 'respond') {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text.trim()) return toolError('text required for "respond" — it is typed into the agent verbatim.');
      // Through `AgentManager.respond`, which is also what clears the park. Writing
      // to the session directly would leave the agent answered and still parked.
      if (!fleet.respond(id, text)) return toolError(notLive(agent.status, 'typed into'));
      return toolJson({ agentId: id, action, means: AGENT_ACTIONS.respond });
    }
    if (action === 'interrupt') {
      if (!fleet.interrupt(id)) return toolError(notLive(agent.status, 'interrupted'));
      return toolJson({ agentId: id, action, means: AGENT_ACTIONS.interrupt });
    }
    if (action === 'complete') {
      if (!fleet.complete(id)) return toolError(notLive(agent.status, 'completed'));
      return toolJson({ agentId: id, action, means: AGENT_ACTIONS.complete });
    }
    if (action === 'kill') {
      if (!fleet.kill(id)) return toolError(notLive(agent.status, 'stopped'));
      return toolJson({ agentId: id, action, means: AGENT_ACTIONS.kill });
    }
    if (action === 'extend_stall') {
      const result = fleet.extendStallPark(id);
      if (!result.ok) return toolError(result.error);
      return toolJson({ agentId: id, action, expiresAt: result.expiresAt, means: AGENT_ACTIONS.extend_stall });
    }
    const result = fleet.resumeParked(id);
    if (!result.ok) return toolError(result.error);
    return toolJson({ agentId: id, action, means: AGENT_ACTIONS.resume });
  },
});

/** Why a verb could not reach the agent, in terms of the row rather than of the map lookup that failed. */
function notLive(status: string, verb: string): string {
  return (
    `This agent is "${status}" and holds no live session, so it cannot be ${verb}. An agent that has ended is ` +
    'a record: its transcript is still readable with agent_read, and there is nothing to act on.'
  );
}
