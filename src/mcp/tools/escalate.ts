import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const escalate: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Ask the human a question and park until they answer. Prefer this over printing the ' +
    'waiting sentinel: you can state what kind of decision you need and offer concrete ' +
    'options, which the cockpit renders as one-click answers. Returns immediately — the ' +
    "human's reply arrives as your next message.",
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One line: what you need decided.' },
      kind: {
        type: 'string',
        enum: ['approve', 'choose', 'clarify', 'review'],
        description: 'What sort of decision this is. Drives how the cockpit files it.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete answers the human can pick with one click.',
      },
      detail: { type: 'string', description: 'Optional background the human needs to decide.' },
    },
    required: ['question'],
  },
  handler: (args) => {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return toolError('escalate requires a non-empty question.');
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
      : [];
    const result = deps.agents.ask(agent.id, {
      question,
      kind: typeof args.kind === 'string' ? args.kind : undefined,
      options: options.length > 0 ? options : undefined,
      detail: typeof args.detail === 'string' && args.detail.trim() ? args.detail.trim() : undefined,
    });
    if (!result.ok) return toolError(result.error);
    // `escalationId: null` means a whitelisted prompt was auto-answered, so the
    // agent was never actually parked. Say so rather than implying a human saw it.
    return ok({
      parked: result.escalationId !== null,
      escalationId: result.escalationId,
      note:
        result.escalationId === null
          ? 'Auto-answered by an operator whitelist rule; continue without waiting.'
          : 'Parked. Continue when the answer arrives as your next message.',
    });
  },
});
