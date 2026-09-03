import { useState } from 'react';
import type { AgentAskQuestion } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';

/**
 * Several questions, answered together.
 *
 * An agent with three things to settle used to have one `question` line and one
 * box, so it wrote all three into `detail` and spent its options on "which do you
 * want to talk about first?" — a round trip per question, and a panel row the
 * height of an essay. The questionnaire gives each question its own card, and the
 * card its own answer.
 *
 * It is a modal rather than an expansion of the inbox row on purpose: "Needs you"
 * is a list of things needing you, and one item that unpacks into three is a list
 * that no longer reads as one.
 *
 * Options *fill* the box rather than being the answer, which is the difference
 * between this and the one-click chips on the card: those settle a question and
 * send, where here every answer waits for the others, so there is nothing lost by
 * letting you pick one and then qualify it.
 */
export function QuestionnaireModal({
  prompt,
  questions,
  onClose,
  onSend,
}: {
  /** The ask's headline — what the inbox row shows. */
  prompt: string;
  questions: AgentAskQuestion[];
  onClose: () => void;
  /** Positional against `questions`; null is "no answer", which is sent, not omitted. */
  onSend: (answers: (string | null)[]) => Promise<unknown> | unknown;
}) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  const answered = answers.filter((a) => a.trim() !== '').length;

  const setAnswer = (index: number, value: string): void =>
    setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));

  return (
    <Modal face="modal" className="qn-modal" title={prompt} onClose={onClose}>
      <div className="qn-list">
        {questions.map((q, i) => (
          <div key={i} className={`qn-q${answers[i]?.trim() ? ' answered' : ''}`}>
            <div className="qn-q-head">
              <span className="qn-num">
                {i + 1} / {questions.length}
              </span>
              <span className="qn-text">{q.question}</span>
            </div>
            {q.detail ? <div className="esc-detail qn-detail">{renderMarkdown(q.detail)}</div> : null}
            {q.options && q.options.length > 0 ? (
              <div className="qn-opts">
                {q.options.map((o) => (
                  <button
                    key={o}
                    className={`qn-opt${answers[i]?.trim() === o ? ' picked' : ''}`}
                    title="Fills the box below — edit it if you want to qualify the answer"
                    onClick={() => setAnswer(i, o)}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              className="qn-box"
              placeholder="Your answer… (leave blank to skip — the agent is told you didn't answer)"
              value={answers[i] ?? ''}
              onChange={(e) => setAnswer(i, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="qn-foot">
        <span className="muted small">
          {answered} of {questions.length} answered
        </span>
        <AsyncButton
          tone="primary"
          // Nothing to send is not a refusal worth a round trip: the route
          // rejects an all-blank set, and the button saying so first is cheaper.
          disabled={answered === 0}
          title={answered === questions.length ? 'Send all answers' : 'Unanswered questions are sent as "no answer"'}
          onClick={async () => {
            await onSend(answers.map((a) => (a.trim() === '' ? null : a.trim())));
            onClose();
          }}
        >
          Send answers
        </AsyncButton>
      </div>
    </Modal>
  );
}
