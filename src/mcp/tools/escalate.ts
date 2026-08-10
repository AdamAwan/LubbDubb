import { toolError } from '../protocol.js';
import type { AgentAskQuestion } from '../../types.js';
import type { ToolFactory } from './context.js';

/**
 * A questionnaire past this stops being a question and becomes a form. The cap is
 * enforced here rather than trusted from `maxItems`: the schema is advice to the
 * model, and the cockpit renders whatever arrives.
 */
const MAX_QUESTIONS = 10;

/** Strings only, trimmed, blanks dropped — anything else came from a model and is not rendered. */
function readOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim());
}

/**
 * The sub-questions, filtered as defensively as the options are. A malformed
 * entry is dropped rather than failing the whole call: an agent that mis-shapes
 * one of three questions should still get the other two in front of a human.
 */
function readQuestions(value: unknown): AgentAskQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: AgentAskQuestion[] = [];
  for (const raw of value.slice(0, MAX_QUESTIONS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const question = typeof entry.question === 'string' ? entry.question.trim() : '';
    if (!question) continue;
    const detail = typeof entry.detail === 'string' && entry.detail.trim() ? entry.detail.trim() : undefined;
    const options = readOptions(entry.options);
    out.push({ question, ...(detail ? { detail } : {}), ...(options.length > 0 ? { options } : {}) });
  }
  return out;
}

export const escalate: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Ask the human a question and park until they answer. Prefer this over printing the ' +
    'waiting sentinel: you can state what kind of decision you need and offer concrete ' +
    'options, which the cockpit renders as one-click answers. Several things to settle go in ' +
    '`questions` as one ask, answered together — do not park three times, and do not bury three ' +
    "questions in `detail`. Returns immediately — the human's reply arrives as your next message.",
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
      detail: {
        type: 'string',
        description:
          'Optional background the human needs to decide. Markdown — the cockpit renders it, so ' +
          'use headings and lists for structure and a fenced code block for errors or output.',
      },
      questions: {
        type: 'array',
        maxItems: MAX_QUESTIONS,
        description:
          'Use this when you need several things settled at once, instead of writing them all ' +
          'into `detail`. Each entry gets its own options and its own answer box, and the human ' +
          'answers them together. Keep `question` as the headline that says what this is about.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'What this one asks.' },
            detail: { type: 'string', description: 'Background for this question alone. Markdown.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Concrete answers; picking one fills this question’s box, still editable.',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['question'],
  },
  handler: (args) => {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return toolError('escalate requires a non-empty question.');
    const options = readOptions(args.options);
    const questions = readQuestions(args.questions);
    const result = deps.agents.ask(agent.id, {
      question,
      kind: typeof args.kind === 'string' ? args.kind : undefined,
      options: options.length > 0 ? options : undefined,
      detail: typeof args.detail === 'string' && args.detail.trim() ? args.detail.trim() : undefined,
      questions: questions.length > 0 ? questions : undefined,
    });
    if (!result.ok) return toolError(result.error);
    // `escalationId: null` means a whitelisted prompt was auto-answered, so the
    // agent was never actually parked. Say so rather than implying a human saw it.
    return ok({
      parked: result.escalationId !== null,
      escalationId: result.escalationId,
      // How many actually landed, not how many were sent: a malformed entry is
      // dropped rather than failing the call, and an agent that asked for three
      // and filed two should be able to see that without the human telling it.
      ...(questions.length > 0 ? { questionsFiled: questions.length } : {}),
      note:
        result.escalationId === null
          ? 'Auto-answered by an operator whitelist rule; continue without waiting.'
          : 'Parked. Continue when the answer arrives as your next message.',
    });
  },
});
