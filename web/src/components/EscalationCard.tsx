import { useState } from 'react';
import type { Escalation, Proposal } from '../types.js';
import { relTime, linkify } from './util.js';
import { renderMarkdown } from './markdown.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';

export function EscalationCard({
  escalation,
  proposal,
  resumedAt,
  now,
  refUrls,
  onAnswer,
  onDecide,
  onPermission,
  onDismiss,
  onOpenAgent,
  onComplete,
  onViewPlan,
}: {
  escalation: Escalation;
  /** The act this item asks you to authorize, when it is a decision and not a question. */
  proposal?: Proposal;
  /**
   * When the agent that raised this was last seen working *after* it parked, if it
   * was. Parking is only a request — the `escalate` tool returns at once — so an
   * agent that carried on leaves this question standing with nobody waiting on it.
   * Shown as a chip rather than clearing the item: the harness can see that the
   * agent moved on, not that the question stopped mattering.
   */
  resumedAt?: string | null;
  now?: number;
  refUrls: Record<string, string>;
  onAnswer: (text: string) => Promise<unknown> | unknown;
  onDecide?: (id: string, verdict: 'accept' | 'reject', note?: string) => Promise<unknown> | unknown;
  /** Allow or deny a permission request an agent is blocked on (issue #130). */
  onPermission?: (id: string, allow: boolean, note?: string) => Promise<unknown> | unknown;
  /** Clear the item without answering it — the note rides along and is recorded. */
  onDismiss?: (id: string, note?: string) => Promise<unknown> | unknown;
  /** Open the originating agent's drawer for the full transcript. */
  onOpenAgent?: (agentId: string) => void;
  /**
   * End the originating agent on the *done* terminal. The commonest item in this
   * panel is an agent that ended its turn without a done sentinel and is asking
   * for direction — and often the direction is "you're finished".
   */
  onComplete?: (agentId: string) => Promise<unknown> | unknown;
  /** Open the full plan behind a `plan` proposal — the card carries a summary, not the decomposition. */
  onViewPlan?: (planId: string) => void;
}) {
  const [text, setText] = useState('');
  const send = useAsyncAction();
  const { context } = escalation;
  const signal = describeSignal(context.originRef, context.prNumber);
  // A live permission request: the agent is blocked inside a tool call awaiting the
  // operator's allow/deny. Like a proposal, free text can't stand in for the verdict.
  const permission = context.permission && onPermission ? context.permission : null;
  // Options the agent supplied through the `escalate` tool beat the prompt-text
  // heuristic: the agent knows what the choices are, where `quickAnswers` can only
  // guess from wording. Fall back to the guess when it didn't say (the sentinel path).
  const offered = agentOptions(context.options);
  const quick = offered ?? quickAnswers(escalation.prompt);
  // A decision, not a question. Free text can't be branched on — that is the
  // whole reason the proposal exists — so the text box is replaced rather than
  // supplemented: the note rides *with* the verdict instead of standing in for it.
  const decidable = proposal?.status === 'pending' && onDecide ? proposal : null;
  // Only meaningful if the agent moved on *after* asking; a stamp from an earlier
  // park would call a brand-new question stale.
  const resumed = resumedAt != null && Date.parse(resumedAt) > Date.parse(escalation.createdAt);

  return (
    <div className="card escalation">
      <div className="card-head">
        <span className="badge escalate">{escalation.type.replace(/_/g, ' ')}</span>
        {decidable && (
          <span className="chip small warn" title="Accepting performs this act; nothing happens until you do">
            needs your decision
          </span>
        )}
        {permission && (
          <span className="chip small warn" title="An agent is blocked on this command until you allow or deny it">
            wants permission
          </span>
        )}
        {resumed && (
          <span
            className="chip small ok"
            title={`The agent has made tool calls since asking (last ${relTime(resumedAt!, now)}), so it carried on rather than waiting. Probably safe to dismiss.`}
          >
            agent resumed
          </span>
        )}
        {signal && <span className="chip small">{linkify(signal, refUrls)}</span>}
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

      {/* Markdown, unlike `recentOutput` above it: that is terminal output and
          preformatted is what it *is*, while this is the agent writing to a human
          and a `<pre>` flattens its structure into one grey block. */}
      {context.detail ? (
        <details className="esc-context" open>
          <summary className="muted small">Detail from the agent</summary>
          <div className="esc-detail">{renderMarkdown(String(context.detail))}</div>
        </details>
      ) : null}

      {context.draft ? (
        <details className="esc-context">
          <summary className="muted small">Draft reply</summary>
          <pre className="esc-output">{context.draft}</pre>
        </details>
      ) : null}

      {/*
        Both act on the *agent*, not on the question — which is why "Mark work
        done" sits here beside the transcript link rather than among the quick
        answers below. A quick answer routes through `answer` -> `agents.respond`,
        which types text into the session and flips the agent back to running: the
        opposite of finishing it. This ends the agent on the done terminal and
        settles this item on the way out.
      */}
      {escalation.agentId ? (
        <div className="esc-agent-actions">
          {onOpenAgent ? (
            <button className="btn ghost small esc-open" onClick={() => onOpenAgent(escalation.agentId!)}>
              Open agent transcript →
            </button>
          ) : null}
          {onComplete ? (
            <AsyncButton
              className="ghost small"
              title="The agent is finished: record it done, reclaim its worktree, and close this out"
              onClick={() => onComplete(escalation.agentId!)}
            >
              Mark work done
            </AsyncButton>
          ) : null}
          {proposal?.kind === 'plan' && onViewPlan && typeof context.planId === 'string' ? (
            <button className="btn ghost small" onClick={() => onViewPlan(context.planId as string)}>
              View the full plan →
            </button>
          ) : null}
        </div>
      ) : proposal?.kind === 'plan' && onViewPlan && typeof context.planId === 'string' ? (
        <div className="esc-agent-actions">
          <button className="btn ghost small" onClick={() => onViewPlan(context.planId as string)}>
            View the full plan →
          </button>
        </div>
      ) : null}

      {permission ? <pre className="esc-output">{permission.summary}</pre> : null}

      {!decidable && !permission && quick.length > 0 && (
        <div className="esc-quick">
          {quick.map((q) => (
            <AsyncButton key={q} className="small" onClick={() => onAnswer(q)}>
              {q}
            </AsyncButton>
          ))}
        </div>
      )}

      {permission ? (
        <div className="esc-decide">
          <input
            placeholder="Why (optional) — recorded either way"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <AsyncButton
            className="primary"
            title="Run this command; the same agent continues"
            onClick={() => onPermission!(escalation.id, true, text.trim() || undefined)}
          >
            Allow
          </AsyncButton>
          <AsyncButton
            className="ghost"
            title="Refuse this command; the agent is told and carries on"
            onClick={() => onPermission!(escalation.id, false, text.trim() || undefined)}
          >
            Deny
          </AsyncButton>
        </div>
      ) : decidable ? (
        <div className="esc-decide">
          <input
            placeholder="Why (optional) — recorded either way"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <AsyncButton
            className="primary"
            title={ACCEPT_HINT[decidable.kind] ?? 'Authorize this act now'}
            onClick={() => onDecide!(decidable.id, 'accept', text.trim() || undefined)}
          >
            {ACCEPT_LABEL[decidable.kind] ?? 'Approve'}
          </AsyncButton>
          <AsyncButton
            className="ghost"
            title={REJECT_HINT[decidable.kind] ?? "Nothing goes out, and the harness won't ask again"}
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

      {onDismiss && (
        <div className="esc-dismiss">
          <AsyncButton
            className="ghost small"
            title={DISMISS_HINT[decidable ? 'proposal' : permission ? 'permission' : 'question']}
            onClick={() => onDismiss(escalation.id, text.trim() || undefined)}
          >
            {decidable ? 'Dismiss (rejects)' : permission ? 'Dismiss (denies)' : 'Dismiss'}
          </AsyncButton>
          {resumed && <span className="muted small">the agent moved on without this</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Why the button says something different on the two kinds that carry a verdict.
 * Dismissing has to mean one thing everywhere — nothing goes out, nobody is left
 * blocked — and for those two that costs a real decision: a permission request has
 * an agent stopped inside a tool call and a proposal has a rule held off a PR, so
 * simply dropping the row would strand one and wedge the other. Each is routed to
 * its own "no" instead, and the label says so before it is pressed.
 */
const DISMISS_HINT: Record<string, string> = {
  question: 'Clear this from "Needs you" without sending the agent anything',
  permission: 'Clear this by denying the command — the agent is told and carries on',
  proposal: 'Clear this by rejecting the proposal — nothing goes out',
};

/**
 * What each verdict does, per kind. Spelled out because they differ in a way the
 * word "reject" hides: refusing an outbound act is refusing to *do* something,
 * whereas refusing a plan reassigns the issue to the single-PR path — the button
 * has to say so before it is pressed.
 */
const ACCEPT_LABEL: Record<string, string> = {
  merge: 'Approve merge',
  reply_draft: 'Approve & send',
  plan: 'Approve plan',
};
const ACCEPT_HINT: Record<string, string> = {
  merge: 'Merge it now',
  reply_draft: 'Send this reply now',
  plan: 'Release the plan — each part gets its own agent, branch and PR',
};
const REJECT_HINT: Record<string, string> = {
  merge: "Nothing goes out, and the harness won't ask again",
  reply_draft: "Nothing goes out, and the harness won't ask again",
  plan: 'Retires the parts nothing has started for and works the issue as a single PR instead',
};

/**
 * Turn a task's `originRef` (or a bare PR number) into a friendly label for the
 * signal chip, so the human sees which PR/issue triggered the work.
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
