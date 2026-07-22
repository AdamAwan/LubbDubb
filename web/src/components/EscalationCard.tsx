import { useState } from 'react';
import type { Escalation } from '../types.js';
import { relTime } from './util.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';

export function EscalationCard({
  escalation,
  now,
  onAnswer,
  onOpenAgent,
}: {
  escalation: Escalation;
  now?: number;
  onAnswer: (text: string) => Promise<unknown> | unknown;
  /** Open the originating agent's drawer for the full transcript. */
  onOpenAgent?: (agentId: string) => void;
}) {
  const [text, setText] = useState('');
  const send = useAsyncAction();
  const { context } = escalation;
  const signal = describeSignal(context.originRef, context.prNumber);
  const quick = quickAnswers(escalation.prompt);

  return (
    <div className="card escalation">
      <div className="card-head">
        <span className="badge escalate">{escalation.type.replace(/_/g, ' ')}</span>
        {signal && <span className="chip small">{signal}</span>}
        <span className="muted small esc-time">{relTime(escalation.createdAt, now)}</span>
      </div>

      <div className="escalation-prompt">{escalation.prompt}</div>

      {context.taskTitle ? <div className="muted small">re: {context.taskTitle}</div> : null}

      {context.recentOutput ? (
        <details className="esc-context" open>
          <summary className="muted small">What the agent was doing</summary>
          <pre className="esc-output">{context.recentOutput}</pre>
        </details>
      ) : null}

      {context.draft ? (
        <details className="esc-context">
          <summary className="muted small">Draft reply</summary>
          <pre className="esc-output">{context.draft}</pre>
        </details>
      ) : null}

      {escalation.agentId && onOpenAgent ? (
        <button className="btn ghost small esc-open" onClick={() => onOpenAgent(escalation.agentId!)}>
          Open agent transcript →
        </button>
      ) : null}

      {quick.length > 0 && (
        <div className="esc-quick">
          {quick.map((q) => (
            <AsyncButton key={q} className="small" onClick={() => onAnswer(q)}>
              {q}
            </AsyncButton>
          ))}
        </div>
      )}

      <form
        className="reply"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text.trim();
          if (!value) return;
          void send.run(async () => {
            await onAnswer(value);
            setText('');
          });
        }}
      >
        <input placeholder="Your answer…" value={text} onChange={(e) => setText(e.target.value)} />
        <SubmitButton phase={send.phase} className="primary">
          Send
        </SubmitButton>
      </form>
    </div>
  );
}

/**
 * Turn a task's `originRef` (or a bare PR number) into a friendly label for the
 * signal chip, so the human sees which PR/issue/story/meeting triggered the work.
 */
function describeSignal(originRef?: string | null, prNumber?: number): string | null {
  if (typeof prNumber === 'number') return `PR #${prNumber}`;
  if (!originRef) return null;
  const [kind, id, sub] = originRef.split(':');
  switch (kind) {
    case 'pr':
      return sub === 'ci' ? `PR #${id} · CI` : `PR #${id} · review comment`;
    case 'issue':
      return `Issue #${id}`;
    case 'meeting':
      return 'Meeting prep';
    case 'story':
      return sub === 'waf' ? 'Story · WAF pillars' : sub === 'groom' ? 'Story · grooming' : 'Story';
    default:
      return originRef;
  }
}

// Words that mark a prompt as a yes/no decision worth a one-click answer.
const YESNO = /\b(should|shall|can|may|is it ok|ok to|approve|proceed|do you want|would you like)\b/i;

/** Quick-answer buttons for prompts that read like a yes/no decision. */
function quickAnswers(prompt: string): string[] {
  return prompt.includes('?') && YESNO.test(prompt) ? ['Yes', 'No'] : [];
}
