import { useState } from 'react';
import type { Escalation } from '../types.js';
import { relTime } from './util.js';

export function EscalationCard({
  escalation,
  now,
  onAnswer,
}: {
  escalation: Escalation;
  now?: number;
  onAnswer: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="card escalation">
      <div className="card-head">
        <span className="badge escalate">{escalation.type.replace(/_/g, ' ')}</span>
        <span className="muted">{relTime(escalation.createdAt, now)}</span>
      </div>
      <div className="escalation-prompt">{escalation.prompt}</div>
      {escalation.context?.taskTitle ? (
        <div className="muted small">re: {String(escalation.context.taskTitle)}</div>
      ) : null}
      <form
        className="reply"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) {
            onAnswer(text.trim());
            setText('');
          }
        }}
      >
        <input placeholder="Your answer…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}
