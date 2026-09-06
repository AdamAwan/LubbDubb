import type { AgentAskQuestion } from '../types.js';

// → docs/spec/05-dispatcher.md

const UNANSWERED = '(no answer — use your own judgement)';

export function formatAnswers(questions: AgentAskQuestion[], answers: readonly (string | null)[]): string {
  return questions
    .map((q, i) => {
      const raw = answers[i];
      const answer = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : UNANSWERED;
      return `${i + 1}. ${q.question}\n${quote(answer)}`;
    })
    .join('\n\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}
