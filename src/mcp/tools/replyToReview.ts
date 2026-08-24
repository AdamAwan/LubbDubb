import { replyOrigin } from '../../dispatcher/reviewThreads.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * How long a reply may be. Generous — a reply that defends an approach has to be
 * able to say why — and a cap at all for `MAX_LESSON_CHARS`' reason: the thing on
 * the other end is a review thread a person reads.
 */
const MAX_REPLY_CHARS = 4000;

/**
 * Hand the harness the reply to a review thread, instead of posting it yourself.
 *
 * **The tool sends nothing.** It raises the same `reply_on_pr` act a rule raises,
 * so the reply takes the route the harness already had for a drafted one: the
 * hold that stops the same question being asked twice, the rejection the operator
 * already gave, the re-ask that names it, their authority — a click, or the
 * config key that says a reply need not be put to them — the sign-off on the way
 * out, and an escalation if the send fails. Calling the sink from here would
 * bypass every one of those, and there would be nothing red.
 *
 * **The pull request comes from the caller's origin, never from an argument** —
 * the channel's one structural guarantee. An agent dispatched on one review
 * cannot answer another pull request's.
 */
export const replyToReview: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Post your reply to a review thread on the pull request you were dispatched for — a defence of ' +
    'the approach the reviewer questioned, an answer to what they asked, or a note saying what you ' +
    'changed for them. One call per thread.\n\n' +
    '**Do not post to the thread yourself.** Not with `gh`, not with `az`, not with the provider’s ' +
    'REST API, not from a shell of any kind, even where your credentials would let you. A reply the ' +
    'harness sends is signed as the harness, recorded against the pull request, and shown to the ' +
    'operator; one you post is unsigned, unrecorded, and attributed to the person whose credential ' +
    'is on this machine, who did not write it.\n\n' +
    'The harness may put your reply to the operator before it goes out — that is their setting, not ' +
    'a fault, and the call tells you which happened. Either way your work here is done when you have ' +
    'called this; nothing is waiting on you afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      body: {
        type: 'string',
        description:
          'The reply, as the reviewer will read it. Answer what they asked and nothing else: what ' +
          'you changed, or why you are keeping the current approach. Do not restate their comment ' +
          'back to them, and do not thank them for it at length.',
      },
      thread: {
        type: 'string',
        description:
          'The id of the review thread you are answering — the "thread <id>" beside each comment in ' +
          'your prompt. Omit it only for a reply to the pull request itself rather than to a thread; ' +
          'an omitted id means nobody reading the thread sees your answer in it.',
      },
    },
    required: ['body'],
  },
  handler: async (args) => {
    const scope = replyOrigin(task.originRef);
    if (!scope.ok) return toolError(scope.error);

    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!body) return toolError('reply_to_review rejected: body is required and must not be empty.');
    if (body.length > MAX_REPLY_CHARS) {
      return toolError(
        `reply_to_review rejected: body is ${body.length} characters and the limit is ${MAX_REPLY_CHARS}. ` +
          'A reviewer reads this in a thread — say the shorter thing.',
      );
    }
    const thread = typeof args.thread === 'string' && args.thread.trim() ? args.thread.trim() : null;

    const desk = deps.prReply;
    if (!desk) {
      return toolError(
        'Replying is not wired on this harness. Say what you would have replied, and to which thread, ' +
          'in the summary you finish with — do not post it to the thread yourself.',
      );
    }

    const outcome = await desk.proposeReply({
      agentId: agent.id,
      prNumber: scope.prNumber,
      commentId: thread,
      draft: body,
      reason: `agent reply on ${scope.originRef}${thread ? ` (thread ${thread})` : ''}`,
    });
    return ok({
      // The act reached the one path that can send it. Whether it has *gone* is
      // the operator's to decide, and `note` is the executor's own account of
      // which happened — one wording, not a second derivation of it here.
      handedOver: true,
      thread,
      pullRequest: scope.prNumber,
      note: outcome.detail,
    });
  },
});
