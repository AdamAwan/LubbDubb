import { z } from 'zod';
import { toolError } from '../protocol.js';
import { toolSchema } from '../schema.js';
import type { AgentAskQuestion } from '../../types.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

const MAX_QUESTIONS = 10;

function readOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim());
}

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
  inputSchema: toolSchema(
    z.object({
      question: z.string().describe('One line: what you need decided.'),
      kind: z
        .enum(['approve', 'choose', 'clarify', 'review'])
        .describe('What sort of decision this is. Drives how the cockpit files it.')
        .optional(),
      options: z.array(z.string()).describe('Concrete answers the human can pick with one click.').optional(),
      detail: z
        .string()
        .describe(
          'Optional background the human needs to decide. Markdown — the cockpit renders it, so ' +
            'use headings and lists for structure and a fenced code block for errors or output.',
        )
        .optional(),
      questions: z
        .array(
          z.object({
            question: z.string().describe('What this one asks.'),
            detail: z.string().describe('Background for this question alone. Markdown.').optional(),
            options: z
              .array(z.string())
              .describe('Concrete answers; picking one fills this question’s box, still editable.')
              .optional(),
          }),
        )
        .max(MAX_QUESTIONS)
        .describe(
          'Use this when you need several things settled at once, instead of writing them all ' +
            'into `detail`. Each entry gets its own options and its own answer box, and the human ' +
            'answers them together. Keep `question` as the headline that says what this is about.',
        )
        .optional(),
    }),
  ),
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
    return ok({
      parked: result.escalationId !== null,
      escalationId: result.escalationId,
      ...(questions.length > 0 ? { questionsFiled: questions.length } : {}),
      note:
        result.escalationId === null
          ? 'Auto-answered by an operator whitelist rule; continue without waiting.'
          : 'Parked. Continue when the answer arrives as your next message.',
    });
  },
});
