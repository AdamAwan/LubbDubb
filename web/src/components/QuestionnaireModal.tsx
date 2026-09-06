import { useState } from 'react';
import type { AgentAskQuestion } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';

// → docs/spec/17-cockpit.md

export function QuestionnaireModal({
  prompt,
  questions,
  onClose,
  onSend,
}: {
  prompt: string;
  questions: AgentAskQuestion[];
  onClose: () => void;
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
