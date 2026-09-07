import { useState } from 'react';
import type { AgentAskQuestion, CaveatAnswerInput, Escalation, Proposal } from '../types.js';
import { relTime, untilTime, linkify } from './util.js';
import { renderMarkdown } from './markdown.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { QuestionnaireModal } from './QuestionnaireModal.js';
import { CaveatChecklist, heldTitle, useAcknowledgements } from './CaveatChecklist.js';
import { PlanAnswers } from './PlanAnswers.js';
import { planCaveatsOf } from '../planCaveats.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function EscalationCard({
  escalation,
  proposal,
  resumedAt,
  now,
  refUrls,
  desktopFolder,
  onAnswer,
  onAnswerQuestions,
  onDecide,
  onBackOut,
  onOverrule,
  onPermission,
  onDismiss,
  onOpenAgent,
  onComplete,
  onExtend,
  stallExpiresAt,
  onViewPlan,
}: {
  escalation: Escalation;
  proposal?: Proposal;
  resumedAt?: string | null;
  now?: number;
  refUrls: Record<string, string>;
  desktopFolder: string;
  onAnswer: (text: string) => Promise<unknown> | unknown;
  onAnswerQuestions?: (answers: (string | null)[]) => Promise<unknown> | unknown;
  onDecide?: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
    answers?: CaveatAnswerInput[],
  ) => Promise<unknown> | unknown;
  onBackOut?: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
  onOverrule?: (issueNumber: number, proposalId: string, text: string) => Promise<unknown> | unknown;
  onPermission?: (id: string, allow: boolean, note?: string) => Promise<unknown> | unknown;
  onDismiss?: (id: string, note?: string) => Promise<unknown> | unknown;
  onOpenAgent?: (agentId: string) => void;
  onComplete?: (agentId: string) => Promise<unknown> | unknown;
  stallExpiresAt?: string | null;
  onExtend?: (agentId: string) => Promise<unknown> | unknown;
  onViewPlan?: (planId: string) => void;
}) {
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const send = useAsyncAction();
  const { context } = escalation;
  const signal = describeSignal(context.originRef, context.prNumber);
  const permission = context.permission && onPermission ? context.permission : null;
  const offered = agentOptions(context.options);
  const quick = offered ?? quickAnswers(escalation.prompt);
  const questions = onAnswerQuestions ? questionnaire(context.questions) : null;
  const decidable = proposal?.status === 'pending' && onDecide ? proposal : null;
  const caveats = planCaveatsOf(decidable ?? undefined);
  const ack = useAcknowledgements(caveats);
  const held = ack.outstanding.length > 0;
  const planDecidable = decidable?.kind === 'plan' && onDecide && onBackOut ? decidable : null;
  const resumed = resumedAt != null && Date.parse(resumedAt) > Date.parse(escalation.createdAt);
  const expiring = escalation.agentId && stallExpiresAt ? stallExpiresAt : null;
  const [headline, prose] = splitPrompt(escalation.prompt);
  const [ask, caution] = splitCaution(prose);
  const draftedBody = typeof context.draft === 'string' && ask.includes(context.draft.trim());
  const body = proposal?.kind === 'plan' || draftedBody ? (caveats.length > 0 ? '' : caution) : prose;
  const planId = proposal?.kind === 'plan' && onViewPlan && typeof context.planId === 'string' ? context.planId : null;
  /* The goal number, from the escalation's context or from the origin it was
     raised on. Both spell the same goal, and only the first is always set: a card
     that has just the origin was dropping the Claude Code hand-off, which is the
     one answer here that needs the number. */
  const issueNumber = goalNumber(context);
  const overrulable =
    decidable?.kind === 'shortfall' && onOverrule && typeof context.issueNumber === 'number'
      ? { proposalId: decidable.id, issueNumber: context.issueNumber }
      : null;

  return (
    <Panel density="padded" className="card escalation">
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
      <div className="escalation-prompt">{linkify(headline, refUrls)}</div>
      {/* The rest of the harness's own prose, paragraph breaks kept. They were
          always in the string and the renderer was eating them — `plan-approval`
          and a wedged plan both write what accepting and rejecting do as their own
          paragraphs, and both arrived as one run-on sentence. */}
      {body ? <div className="escalation-body">{renderMarkdown(body, refUrls)}</div> : null}

      {context.taskTitle ? <div className="muted small">re: {linkify(String(context.taskTitle), refUrls)}</div> : null}

      {context.recentOutput ? (
        <details className="esc-context" open>
          <summary className="muted small">What the agent was doing</summary>
          <pre className="esc-output">{context.recentOutput}</pre>
        </details>
      ) : null}

      {/* Markdown, unlike `recentOutput` above it: that is terminal output and
          preformatted is what it *is*, while this is someone writing to a human
          and a `<pre>` flattens its structure into one grey block.

          Not a `<details>`, and not height-capped. This is the thing you opened
          the panel to read — `Bench.tsx` makes the same call for its stations,
          "a `<details>` you have to open first is a step between you and the job"
          — and a 180px window onto a two-thousand-character assessment is the
          wall it replaced, with a scrollbar. The card grows; the panel scrolls. */}
      {context.detail ? (
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
            <Button ghost size="small" className="esc-open" onClick={() => onOpenAgent(escalation.agentId!)}>
              Open agent transcript →
            </Button>
          ) : null}
          {onComplete ? (
            <AsyncButton
              ghost
              size="small"
              title="The agent is finished: record it done, reclaim its worktree, and close this out"
              onClick={() => onComplete(escalation.agentId!)}
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
              onClick={() => onExtend(escalation.agentId!)}
            >
              Give me 15 minutes
            </AsyncButton>
          ) : null}
        </div>
      ) : null}

      {planId && !planDecidable ? (
        <Button className="esc-plan-open" onClick={() => onViewPlan!(planId)}>
          <span className="esc-plan-open-label">Read the full plan</span>
          <span className="esc-plan-open-hint">the split, the evidence, what it rules out →</span>
        </Button>
      ) : null}

      {permission ? <pre className="esc-output">{permission.summary}</pre> : null}

      {!decidable && !permission && !questions && quick.length > 0 && (
        <div className="esc-quick">
          {quick.map((q) => (
            <AsyncButton key={q} size="small" onClick={() => onAnswer(q)}>
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
            tone="primary"
            title="Run this command; the same agent continues"
            onClick={() => onPermission!(escalation.id, true, text.trim() || undefined)}
          >
            Allow
          </AsyncButton>
          <AsyncButton
            ghost
            title="Refuse this command; the agent is told and carries on"
            onClick={() => onPermission!(escalation.id, false, text.trim() || undefined)}
          >
            Deny
          </AsyncButton>
        </div>
      ) : planDecidable ? (
        <>
          <CaveatChecklist
            caveats={caveats}
            ticked={ack.ticked}
            answers={ack.written}
            onToggle={ack.toggle}
            onAnswer={ack.answer}
            refUrls={refUrls}
          />
          <PlanAnswers
            proposalId={planDecidable.id}
            issueNumber={issueNumber}
            approveLabel={ACCEPT_LABEL.plan ?? 'Approve'}
            outstanding={ack.outstanding}
            acknowledged={ack.acknowledged}
            answers={ack.answers}
            desktopFolder={desktopFolder}
            {...(planId ? { onReadPlan: () => onViewPlan!(planId) } : {})}
            discussExplain="so the plan is talked through with a session that can amend it — nothing is scheduled, and nothing changes until it does."
            onDecide={onDecide!}
            onBackOut={onBackOut!}
          />
        </>
      ) : decidable ? (
        <>
          <CaveatChecklist
            caveats={caveats}
            ticked={ack.ticked}
            answers={ack.written}
            onToggle={ack.toggle}
            onAnswer={ack.answer}
            refUrls={refUrls}
          />
          <div className="esc-decide">
            <input
              placeholder={
                overrulable ? 'Why — optional to decide, required to overrule' : 'Why (optional) — recorded either way'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <AsyncButton
              tone="primary"
              disabled={held}
              title={held ? heldTitle(ack.outstanding) : (ACCEPT_HINT[decidable.kind] ?? 'Authorize this act now')}
              onClick={() => onDecide!(decidable.id, 'accept', text.trim() || undefined, ack.acknowledged, ack.answers)}
            >
              {ACCEPT_LABEL[decidable.kind] ?? 'Approve'}
            </AsyncButton>
            <AsyncButton
              ghost
              title={REJECT_HINT[decidable.kind] ?? "Nothing goes out, and the harness won't ask again"}
              onClick={() => onDecide!(decidable.id, 'reject', text.trim() || undefined)}
            >
              Reject
            </AsyncButton>
            {overrulable && (
              <AsyncButton
                ghost
                disabled={text.trim().length === 0}
                title={
                  text.trim().length === 0
                    ? 'Say why the assessment is wrong — it becomes the delivery’s reason and the correction the ticket gets'
                    : 'Records the goal delivered with your reason, and puts the same words in front of the retrospective to get them onto the ticket'
                }
                onClick={() => onOverrule!(overrulable.issueNumber, overrulable.proposalId, text.trim())}
              >
                Overrule the assessment
              </AsyncButton>
            )}
          </div>
        </>
      ) : questions ? (
        <div className="esc-quick">
          <AsyncButton tone="primary" onClick={() => setAsking(true)}>
            Answer {questions.length} questions →
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
          <SubmitButton phase={send.phase} tone="primary">
            Send
          </SubmitButton>
        </form>
      )}

      {/* Not on a card that asks for a verdict: those already carry the answer
          that clears them — Reject, or the ticket answers under a plan — and a
          second control that rejects by another name is one an operator presses
          meaning "not now". */}
      {onDismiss && !decidable && (
        <div className="esc-dismiss">
          <AsyncButton
            ghost
            size="small"
            title={DISMISS_HINT[permission ? 'permission' : 'question']}
            onClick={() => onDismiss(escalation.id, text.trim() || undefined)}
          >
            {permission ? 'Dismiss (denies)' : 'Dismiss'}
          </AsyncButton>
          {resumed && <span className="muted small">the agent moved on without this</span>}
        </div>
      )}

      {asking && questions && onAnswerQuestions ? (
        <QuestionnaireModal
          prompt={escalation.prompt}
          questions={questions}
          onClose={() => setAsking(false)}
          onSend={onAnswerQuestions}
        />
      ) : null}
    </Panel>
  );
}

function splitPrompt(prompt: string): [headline: string, body: string] {
  const at = prompt.search(/\r?\n\s*\r?\n/);
  return at === -1 ? [prompt.trim(), ''] : [prompt.slice(0, at).trim(), prompt.slice(at).trim()];
}

function splitCaution(body: string): [prose: string, caution: string] {
  const at = body.search(/(^|\n)Before you decide:/);
  return at === -1 ? [body, ''] : [body.slice(0, at).trim(), body.slice(at).trim()];
}

function goalNumber(context: Record<string, unknown>): number | null {
  if (typeof context.issueNumber === 'number') return context.issueNumber;
  const origin = typeof context.originRef === 'string' ? /^issue:(\d+)/.exec(context.originRef) : null;
  return origin ? Number(origin[1]) : null;
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
  plan: 'Sends the plan back to a planner with your note; parts nothing has started for are retired',
};

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

const YESNO = /\b(should|shall|can|may|is it ok|ok to|approve|proceed|do you want|would you like)\b/i;

function quickAnswers(prompt: string): string[] {
  return prompt.includes('?') && YESNO.test(prompt) ? ['Yes', 'No'] : [];
}

function agentOptions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.filter((o): o is string => typeof o === 'string' && o.trim() !== '');
  return options.length > 0 ? options : null;
}

function questionnaire(value: unknown): AgentAskQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions = value.flatMap((raw): AgentAskQuestion[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const entry: Record<string, unknown> = raw;
    if (typeof entry.question !== 'string' || entry.question.trim() === '') return [];
    const options = agentOptions(entry.options);
    return [
      {
        question: entry.question,
        ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
        ...(options ? { options } : {}),
      },
    ];
  });
  return questions.length > 0 ? questions : null;
}
