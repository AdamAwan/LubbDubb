/**
 * Turning a questionnaire's per-question answers into the one message a parked
 * agent receives.
 *
 * It lives here rather than in the route or the cockpit because it encodes a
 * domain rule — how an agent reads what it was told — and an answer typed by a
 * second client must read identically to one typed by the first. Pure, total,
 * and unit-tested directly.
 */
import type { AgentAskQuestion } from '../types.js';

/**
 * What an unanswered question is sent as. Present rather than omitted on
 * purpose: an agent that asked three things and hears about two would sit
 * waiting on the third, which is the exact stall the questionnaire exists to
 * end. Saying so instead releases it.
 */
const UNANSWERED = '(no answer — use your own judgement)';

/**
 * The reply for a questionnaire. `answers` is positional against `questions`;
 * short, blank and whitespace-only entries all read as unanswered, so a caller
 * never has to pad the array to make it line up.
 */
export function formatAnswers(questions: AgentAskQuestion[], answers: readonly (string | null)[]): string {
  return questions
    .map((q, i) => {
      const raw = answers[i];
      const answer = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : UNANSWERED;
      return `${i + 1}. ${q.question}\n${quote(answer)}`;
    })
    .join('\n\n');
}

/** Every line prefixed, so a multi-line answer stays visibly one answer. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}
