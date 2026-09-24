import type { JSX } from 'react';
import { relTime, untilTime, linkify } from './util.js';
import { renderMarkdown } from './markdown.js';
import { AsyncButton } from './AsyncButton.js';
import { CheckSetAsk, useCheckDeclines } from './CheckSetAsk.js';
import { HOLDS_NOTHING_UP, PREDICT_WHY } from './PlanRevealGate.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import type { Escalation } from '../types.js';
import type { Card, CardProps } from './escalationReading.js';

// → docs/spec/17-cockpit.md

type Declines = ReturnType<typeof useCheckDeclines>;

export function CardHead({
  escalation,
  card,
  resumedAt,
  now,
  refUrls,
}: {
  escalation: Escalation;
  card: Card;
  resumedAt: string | null | undefined;
  now: number | undefined;
  refUrls: Record<string, string>;
}): JSX.Element {
  const { questions, decidable, permission, resumed, expiring, signal } = card;
  return (
    <div className="card-head">
      <Tag tone="accent" fill>
        {escalation.type.replace(/_/g, ' ')}
      </Tag>
      {questions && (
        <Tag tone="blue" title="Answered together, in one reply">
          {questions.length} questions
        </Tag>
      )}
      {decidable && (
        <Tag tone="amber" title="Accepting performs this act; nothing happens until you do">
          needs your decision
        </Tag>
      )}
      {permission && (
        <Tag tone="amber" title="An agent is blocked on this command until you allow or deny it">
          wants permission
        </Tag>
      )}
      {resumed && (
        <Tag
          tone="green"
          title={`The agent has made tool calls since asking (last ${relTime(resumedAt!, now)}), so it carried on rather than waiting. Probably safe to dismiss.`}
        >
          agent resumed
        </Tag>
      )}
      {expiring && (
        <span
          className="tag t-amber esc-expiry"
          title="This agent stopped without saying whether it had finished, and did not answer when asked. Unless you say otherwise, the harness records it done when this runs out — its branch, commits and pull request are kept, and its worktree slot goes back to the fleet."
        >
          done in {untilTime(expiring, now)}
        </span>
      )}
      {signal && <Tag>{linkify(signal, refUrls)}</Tag>}
      <span className="muted small esc-time">{relTime(escalation.createdAt, now)}</span>
    </div>
  );
}

export function CardProse({
  escalation,
  card,
  refUrls,
}: {
  escalation: Escalation;
  card: Card;
  refUrls: Record<string, string>;
}): JSX.Element {
  const { context } = escalation;
  return (
    <>
      <div className="escalation-prompt">{linkify(card.headline, refUrls)}</div>
      {/* The rest of the harness's own prose, paragraph breaks kept. They were
          always in the string and the renderer was eating them — `plan-approval`
          and a wedged plan both write what accepting and rejecting do as their own
          paragraphs, and both arrived as one run-on sentence. */}
      {card.body ? <div className="escalation-body">{renderMarkdown(card.body, refUrls)}</div> : null}

      {context.taskTitle ? <div className="muted small">re: {linkify(String(context.taskTitle), refUrls)}</div> : null}

      {context.recentOutput ? (
        <details className="esc-context" open>
          <summary className="muted small">What the agent was doing</summary>
          <pre className="esc-output">{context.recentOutput}</pre>
        </details>
      ) : null}
    </>
  );
}

export function CardDetail({
  escalation,
  card,
  refUrls,
  declines,
}: {
  escalation: Escalation;
  card: Card;
  refUrls: Record<string, string>;
  declines: Declines;
}): JSX.Element {
  const { context } = escalation;
  const { checkSet, gated, decidable } = card;
  return (
    <>
      {/* Markdown, unlike `recentOutput` above it: that is terminal output and
          preformatted is what it *is*, while this is someone writing to a human
          and a `<pre>` flattens its structure into one grey block.

          Not a `<details>`, and not height-capped. This is the thing you opened
          the panel to read — `Bench.tsx` makes the same call for its stations,
          "a `<details>` you have to open first is a step between you and the job"
          — and a 180px window onto a two-thousand-character assessment is the
          wall it replaced, with a scrollbar. The card grows; the panel scrolls. */}
      {checkSet !== null ? <CheckSetAsk set={checkSet} declines={declines} /> : null}

      {/* The stand-in is the *same sentence* as the prompt above it, so a withheld
          plan drew "it is withheld until you reveal it" twice and made no case for
          the press under it. The gate's own argument stands here instead: this card
          is where the operator meets the plan first, and the offer has to be made
          where it is met. → docs/spec/17-cockpit.md#the-reveal-gate */}
      {gated ? (
        <div className="esc-context">
          <div className="lb lb-sm">Why you are being stopped</div>
          <div className="esc-detail">
            <p>
              {PREDICT_WHY} {HOLDS_NOTHING_UP}
            </p>
          </div>
        </div>
      ) : context.detail && checkSet === null ? (
        <div className="esc-context">
          <div className="lb lb-sm">{detailLabel(context, escalation.agentId)}</div>
          <div className="esc-detail">{renderMarkdown(String(context.detail), refUrls)}</div>
        </div>
      ) : null}

      {context.draft ? (
        <details className="esc-context" open={decidable?.kind === 'reply_draft'}>
          <summary className="muted small">Draft reply</summary>
          <pre className="esc-output">{context.draft}</pre>
        </details>
      ) : null}
    </>
  );
}

export function AgentActions({
  agentId,
  expiring,
  onOpenAgent,
  onComplete,
  onExtend,
}: {
  agentId: string;
  expiring: string | null;
  onOpenAgent?: ((agentId: string) => void) | undefined;
  onComplete?: ((agentId: string) => Promise<unknown> | unknown) | undefined;
  onExtend?: ((agentId: string) => Promise<unknown> | unknown) | undefined;
}): JSX.Element {
  return (
    <div className="esc-agent-actions">
      {onOpenAgent ? (
        <Button ghost size="small" className="esc-open" onClick={() => onOpenAgent(agentId)}>
          Open agent transcript →
        </Button>
      ) : null}
      {onComplete ? (
        <AsyncButton
          ghost
          size="small"
          title="The agent is finished: record it done, reclaim its worktree, and close this out"
          onClick={() => onComplete(agentId)}
        >
          Mark work done
        </AsyncButton>
      ) : null}
      {/* Only where a clock is actually running: an Extend button on a card with
          no countdown would offer to postpone nothing, and 409. */}
      {expiring && onExtend ? (
        <AsyncButton
          ghost
          size="small"
          title="Hold the countdown for another fifteen minutes while you read the transcript. Nothing is decided by this."
          onClick={() => onExtend(agentId)}
        >
          Give me 15 minutes
        </AsyncButton>
      ) : null}
    </div>
  );
}

export function PlanOpen({
  card,
  onViewPlan,
}: {
  card: Card;
  onViewPlan: CardProps['onViewPlan'];
}): JSX.Element | null {
  const { planId, planDecidable, gated } = card;
  if (!planId || planDecidable || gated) return null;
  return (
    <Button className="esc-plan-open" onClick={() => onViewPlan!(planId)}>
      <span className="esc-plan-open-label">Read the full plan</span>
      <span className="esc-plan-open-hint">the split, the evidence, what it rules out →</span>
    </Button>
  );
}

export function QuickAnswers({ card, onAnswer }: { card: Card; onAnswer: CardProps['onAnswer'] }): JSX.Element | null {
  const { decidable, permission, questions, quick } = card;
  if (decidable || permission || questions || quick.length === 0) return null;
  return (
    <div className="esc-quick">
      {quick.map((q) => (
        <AsyncButton key={q} size="small" onClick={() => onAnswer(q)}>
          {q}
        </AsyncButton>
      ))}
    </div>
  );
}

/* Not on a card that asks for a verdict: those already carry the answer
   that clears them — Reject, or the ticket answers under a plan — and a
   second control that rejects by another name is one an operator presses
   meaning "not now". */
export function DismissRow({
  card,
  escalationId,
  text,
  onDismiss,
}: {
  card: Card;
  escalationId: string;
  text: string;
  onDismiss: CardProps['onDismiss'];
}): JSX.Element | null {
  if (!onDismiss || card.decidable) return null;
  const { permission } = card;
  return (
    <div className="esc-dismiss">
      <AsyncButton
        ghost
        size="small"
        title={DISMISS_HINT[permission ? 'permission' : 'question']}
        onClick={() => onDismiss(escalationId, text.trim() || undefined)}
      >
        {permission ? 'Dismiss (denies)' : 'Dismiss'}
      </AsyncButton>
      {card.resumed && <span className="muted small">the agent moved on without this</span>}
    </div>
  );
}

function detailLabel(context: Record<string, unknown>, agentId: string | null | undefined): string {
  const declared = context.detailFrom;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return agentId ? 'Detail from the agent' : 'Detail';
}

const DISMISS_HINT: Record<string, string> = {
  question: 'Clear this from "Needs you" without sending the agent anything',
  permission: 'Clear this by denying the command — the agent is told and carries on',
};
