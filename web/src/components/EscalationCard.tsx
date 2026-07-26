import { useState } from 'react';
import type { Escalation, Proposal } from '../types.js';
import { relTime, linkify } from './util.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';

export function EscalationCard({
  escalation,
  proposal,
  now,
  refUrls,
  onAnswer,
  onDecide,
  onOpenAgent,
}: {
  escalation: Escalation;
  /** The act this item asks you to authorize, when it is a decision and not a question. */
  proposal?: Proposal;
  now?: number;
  refUrls: Record<string, string>;
  onAnswer: (text: string) => Promise<unknown> | unknown;
  onDecide?: (id: string, verdict: 'accept' | 'reject', note?: string) => Promise<unknown> | unknown;
  /** Open the originating agent's drawer for the full transcript. */
  onOpenAgent?: (agentId: string) => void;
}) {
  const [text, setText] = useState('');
  const send = useAsyncAction();
  const { context } = escalation;
  const signal = describeSignal(context.originRef, context.prNumber);
  // Options the agent supplied through the `escalate` tool beat the prompt-text
  // heuristic: the agent knows what the choices are, where `quickAnswers` can only
  // guess from wording. Fall back to the guess when it didn't say (the sentinel path).
  const offered = agentOptions(context.options);
  const quick = offered ?? quickAnswers(escalation.prompt);
  // A decision, not a question. Free text can't be branched on — that is the
  // whole reason the proposal exists — so the text box is replaced rather than
  // supplemented: the note rides *with* the verdict instead of standing in for it.
  const decidable = proposal?.status === 'pending' && onDecide ? proposal : null;

  return (
    <div className="card escalation">
      <div className="card-head">
        <span className="badge escalate">{escalation.type.replace(/_/g, ' ')}</span>
        {decidable && (
          <span className="chip small warn" title="Accepting performs this act; nothing happens until you do">
            needs your decision
          </span>
        )}
        {signal && <span className="chip small">{signal}</span>}
        <span className="muted small esc-time">{relTime(escalation.createdAt, now)}</span>
      </div>
      <div className="escalation-prompt">{linkify(escalation.prompt, refUrls)}</div>

      {context.taskTitle ? <div className="muted small">re: {linkify(String(context.taskTitle), refUrls)}</div> : null}

      {context.recentOutput ? (
        <details className="esc-context" open>
          <summary className="muted small">What the agent was doing</summary>
          <pre className="esc-output">{context.recentOutput}</pre>
        </details>
      ) : null}

      {context.detail ? (
        <details className="esc-context" open>
          <summary className="muted small">Detail from the agent</summary>
          <pre className="esc-output">{String(context.detail)}</pre>
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

      {!decidable && quick.length > 0 && (
        <div className="esc-quick">
          {quick.map((q) => (
            <AsyncButton key={q} className="small" onClick={() => onAnswer(q)}>
              {q}
            </AsyncButton>
          ))}
        </div>
      )}

      {decidable ? (
        <div className="esc-decide">
          <input
            placeholder="Why (optional) — recorded either way"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <AsyncButton
            className="primary"
            title={decidable.kind === 'merge' ? 'Merge it now' : 'Send this reply now'}
            onClick={() => onDecide!(decidable.id, 'accept', text.trim() || undefined)}
          >
            {decidable.kind === 'merge' ? 'Approve merge' : 'Approve & send'}
          </AsyncButton>
          <AsyncButton
            className="ghost"
            title="Nothing goes out, and the harness won't ask again"
            onClick={() => onDecide!(decidable.id, 'reject', text.trim() || undefined)}
          >
            Reject
          </AsyncButton>
        </div>
      ) : (
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
      )}
    </div>
  );
}

/**
 * Turn a task's `originRef` (or a bare PR number) into a friendly label for the
 * signal chip, so the human sees which PR/issue/story triggered the work.
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

/**
 * The options an agent offered through the `escalate` tool, or null if it offered
 * none. Null rather than `[]` so the caller can tell "the agent said nothing"
 * (fall back to the heuristic) from "the agent offered no choices".
 *
 * Defensive about the shape: `context` is an open bag reaching us from an agent's
 * tool arguments, so anything non-string is dropped rather than rendered.
 */
function agentOptions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.filter((o): o is string => typeof o === 'string' && o.trim() !== '');
  return options.length > 0 ? options : null;
}
