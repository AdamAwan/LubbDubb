import { useState } from 'react';
import type { AgentAskQuestion, Escalation, Proposal } from '../types.js';
import { relTime, untilTime, linkify } from './util.js';
import { renderMarkdown } from './markdown.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { QuestionnaireModal } from './QuestionnaireModal.js';
import { CaveatChecklist, heldTitle, useAcknowledgements } from './CaveatChecklist.js';
import { planCaveatsOf } from '../planCaveats.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

export function EscalationCard({
  escalation,
  proposal,
  resumedAt,
  now,
  refUrls,
  onAnswer,
  onAnswerQuestions,
  onDecide,
  onBackOut,
  onCommentDraft,
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
  /**
   * Answer a questionnaire: one entry per question, positional, null for the ones
   * left blank. Separate from {@link onAnswer} because the server folds these into
   * the single reply the agent reads — the cockpit must not invent that wording,
   * or two clients would say the same thing differently.
   */
  onAnswerQuestions?: (answers: (string | null)[]) => Promise<unknown> | unknown;
  /**
   * The verdict, with the caveat ids the operator ticked. `acknowledged` is what
   * releases the accept server-side — the glass holding the button is the same
   * answer given earlier, not the enforcement.
   */
  onDecide?: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
  ) => Promise<unknown> | unknown;
  /**
   * A plan proposal's other two answers, and the ones the card had no way to say:
   * the ticket is not really an issue (close it, with the note as its comment), or
   * it needs more thought before anybody works it (hold it — the watch tag comes
   * off and the plan waits where it is). Separate from {@link onDecide} because
   * neither is a verdict on the plan: rejecting sends the goal back to a planner,
   * which is the wrong answer to both.
   */
  onBackOut?: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
  /**
   * Fetch the placeholder comment for a close, to be edited before it is sent.
   * The draft is *put in the box*, never posted from here — what lands on the
   * ticket is whatever the operator sends with the verdict.
   */
  onCommentDraft?: (id: string) => Promise<string>;
  /**
   * A shortfall proposal's third arm: the assessment is wrong, and the note says
   * why. Separate from {@link onDecide} because it is not a verdict on the act
   * being proposed but on the one behind it — accepting spends an agent on work
   * already done, rejecting leaves the assessment standing to be re-derived, and
   * neither is "no, that finding is mistaken".
   */
  onOverrule?: (issueNumber: number, proposalId: string, text: string) => Promise<unknown> | unknown;
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
  /**
   * When the harness will record this agent done by itself — set only for the park
   * it applies to, an agent that ended a turn without saying whether it had
   * finished. Everything else on this panel is a question somebody asked, and a
   * question that expires is worse than no question at all.
   */
  stallExpiresAt?: string | null;
  /** Buy more of that time. Offered only alongside {@link stallExpiresAt}. */
  onExtend?: (agentId: string) => Promise<unknown> | unknown;
  /** Open the full plan behind a `plan` proposal — the card carries what it does, not how it is cut up. */
  onViewPlan?: (planId: string) => void;
}) {
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
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
  // Several questions asked at once. The list does not unpack into the panel —
  // "Needs you" is a list of things needing you, and one item that becomes three
  // is a list that no longer reads as one — so the card carries a count and a
  // button, and the questions live in the modal.
  const questions = onAnswerQuestions ? questionnaire(context.questions) : null;
  // A decision, not a question. Free text can't be branched on — that is the
  // whole reason the proposal exists — so the text box is replaced rather than
  // supplemented: the note rides *with* the verdict instead of standing in for it.
  const decidable = proposal?.status === 'pending' && onDecide ? proposal : null;
  // What this plan raises, and the ticks against it. Read off the proposal — the
  // same row the accept route reads — so the boxes and the gate cannot disagree.
  // `useAcknowledgements` is called unconditionally: it is a hook, and a card whose
  // proposal is settled simply gets an empty list.
  const caveats = planCaveatsOf(decidable ?? undefined);
  const ack = useAcknowledgements(caveats);
  const held = ack.outstanding.length > 0;
  // Only a plan has a ticket behind it to close or hold: a merge and a reply draft
  // are acts on a pull request, and a shortfall is about work already delivered.
  const backOutable = decidable?.kind === 'plan' && onBackOut ? decidable : null;
  // Only meaningful if the agent moved on *after* asking; a stamp from an earlier
  // park would call a brand-new question stale.
  const resumed = resumedAt != null && Date.parse(resumedAt) > Date.parse(escalation.createdAt);
  // The countdown, drawn only where there is an agent to settle: a stall park is
  // always attached to one, and a card without the agent has no control to offer.
  const expiring = escalation.agentId && stallExpiresAt ? stallExpiresAt : null;
  const [headline, prose] = splitPrompt(escalation.prompt);
  const [ask, caution] = splitCaution(prose);
  // What the card draws under its headline, and the whole of what a plan approval
  // dropped. A plan's ask is four paragraphs the plan panel says better — why the
  // planner split it that way, and what approving and rejecting do, which is what
  // the two buttons' own hints say — and above it sits `detail`, the planner's
  // diagnosis and approach, the same summary the plan sheet leads with. Drawing
  // both made the card on the goal page taller than the goal page. What is kept
  // is the appended caution, because it is the one part that is about *this*
  // decision and appears nowhere else.
  //
  // A drafted reply drops its prose for the same reason and a plainer one: its
  // body *is* the draft, which the card already draws in a block of its own with
  // a label on it.
  const draftedBody = typeof context.draft === 'string' && ask.includes(context.draft.trim());
  // The caution *is* the caveat list in prose, so drawing both would ask the
  // operator to read the same three sentences twice — once as a paragraph and once
  // beside a box. The checklist wins: it is the half that has to be acted on.
  const body = proposal?.kind === 'plan' || draftedBody ? (caveats.length > 0 ? '' : caution) : prose;
  // The plan behind a `plan` proposal. Drawn as its own control below the body
  // rather than as one more ghost link among the agent actions: the card carries
  // what the plan diagnosed and what it will do, and everything else about it —
  // the split as a diagram, the evidence, the risks, what it ruled out — is in
  // that panel. Reading it is the thing to do before approving, so it is the
  // thing the card looks like it wants.
  const planId = proposal?.kind === 'plan' && onViewPlan && typeof context.planId === 'string' ? context.planId : null;
  // The shortfall card's third arm. Offered only where it can act: it writes a
  // verdict against a goal, so a proposal whose context lost the issue number gets
  // the two arms it always had rather than a button that would 400.
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

      {planId ? (
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
      ) : decidable ? (
        <>
          <CaveatChecklist caveats={caveats} ticked={ack.ticked} onToggle={ack.toggle} refUrls={refUrls} />
          <div className="esc-decide">
            <input
              placeholder={
                backOutable
                  ? 'Why (optional to decide) — required to close, and it is what the ticket gets'
                  : overrulable
                    ? 'Why — optional to decide, required to overrule'
                    : 'Why (optional) — recorded either way'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <AsyncButton
              tone="primary"
              // Disabled rather than hidden, and rather than left to 400: the button
              // is where the operator is looking, so what is holding it belongs in
              // its own hint. The route refuses it either way — this is the same
              // answer given a step earlier.
              disabled={held}
              title={held ? heldTitle(ack.outstanding) : (ACCEPT_HINT[decidable.kind] ?? 'Authorize this act now')}
              onClick={() => onDecide!(decidable.id, 'accept', text.trim() || undefined, ack.acknowledged)}
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
                // Disabled rather than hidden until there are words, because the words
                // *are* the act: an overrule with nothing in the box records "delivered"
                // for a reason nobody can read, which is the assessment problem again
                // with the operator's name on it.
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
          {backOutable && (
            /* Set apart below the two answers, the way dismissing is: neither of
             these answers the question the card asked. Approve and Reject are both
             about the *plan* — a rejection asks a planner for a different one — and
             these two are about the ticket. */
            <div className="esc-backout">
              <span className="muted small">Not the work you want?</span>
              <AsyncButton
                ghost
                // Disabled rather than hidden until there are words, for the overrule's
                // reason and one more: the note is posted on somebody's tracker as the
                // reason it closed, and a close nobody can read the reason for is the
                // thing this control exists to stop.
                disabled={text.trim().length === 0}
                title={
                  text.trim().length === 0
                    ? 'Say why — your words go on the ticket as the closing comment'
                    : 'Comments with your words, closes the ticket, stops watching it and abandons the plan'
                }
                onClick={() => onBackOut!(backOutable.id, 'close', text.trim())}
              >
                Close the ticket
              </AsyncButton>
              {onCommentDraft && (
                <AsyncButton
                  ghost
                  title="Put a draft comment in the box to edit — nothing is posted until you close the ticket"
                  onClick={async () => setText(await onCommentDraft(backOutable.id))}
                >
                  Draft a comment
                </AsyncButton>
              )}
              <AsyncButton
                ghost
                title="Stops watching the ticket and sends this plan back. Nothing is scheduled for it — watch it again and a fresh plan is written."
                onClick={() => onBackOut!(backOutable.id, 'hold', text.trim() || undefined)}
              >
                Hold — stop watching
              </AsyncButton>
            </div>
          )}
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

      {onDismiss && (
        <div className="esc-dismiss">
          <AsyncButton
            ghost
            size="small"
            title={DISMISS_HINT[decidable ? 'proposal' : permission ? 'permission' : 'question']}
            onClick={() => onDismiss(escalation.id, text.trim() || undefined)}
          >
            {decidable ? 'Dismiss (rejects)' : permission ? 'Dismiss (denies)' : 'Dismiss'}
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

/**
 * A prompt's headline and its body: everything up to the first blank line, and
 * everything after it.
 *
 * Split here rather than at the authoring end because the two halves are the same
 * author's words. A rule writing "here is what happened" and then "here is what
 * accepting does" is writing one message with two paragraphs, and asking every
 * rule — and every operator override — to file the second half somewhere else
 * would be a second contract to get wrong. What *does* move to a field of its own
 * is text the harness is quoting from an agent, which is `context.detail`.
 *
 * A prompt with no blank line has no body, which is the common case and the one
 * every already-short escalation is in.
 */
function splitPrompt(prompt: string): [headline: string, body: string] {
  const at = prompt.search(/\r?\n\s*\r?\n/);
  return at === -1 ? [prompt.trim(), ''] : [prompt.slice(0, at).trim(), prompt.slice(at).trim()];
}

/**
 * A body's own prose and the caution the harness appended to it.
 *
 * `caveatNotice` (`src/plans/planCaveats.ts`) writes its bullets under a
 * `Before you decide:` line, appended rather than interpolated — so the marker is
 * the harness's own and no operator override can lose it. Split here because the
 * two halves are read differently: the prose restates what the plan sheet draws,
 * and the caution is the only part of the ask that is about *this* decision — an
 * unclaimed pull request on the branch, parts already blocked. A card that drops
 * the first must keep the second — except where the same caveats are drawn as
 * boxes to tick, and then the paragraph is the checklist restated and the card
 * drops it (see the `caveats` reading below).
 *
 * No marker means no caution, which is the common case.
 */
function splitCaution(body: string): [prose: string, caution: string] {
  const at = body.search(/(^|\n)Before you decide:/);
  return at === -1 ? [body, ''] : [body.slice(0, at).trim(), body.slice(at).trim()];
}

/**
 * Who wrote the block under the headline.
 *
 * **Declared by whoever quoted the text, never derived here.** Deriving it from
 * `agentId` is the obvious move and it is wrong: the harness quotes an assessor
 * on a shortfall and a planner on a decomposition, and both arrive with no agent
 * behind them, so a rule reading "no agent, therefore an assessor" mislabels
 * every plan approval — which is exactly what it did, until the golden markup
 * caught it. Same discipline as a shortfall's `cause`: the party that knows says
 * so, and nothing downstream has a second opinion.
 *
 * The fallback names only what is actually known — that an agent raised this, or
 * nothing at all — rather than guessing at a role.
 */
function detailLabel(context: Record<string, unknown>, agentId: string | null | undefined): string {
  const declared = context.detailFrom;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return agentId ? 'Detail from the agent' : 'Detail';
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
 * whereas refusing a plan sends it back to a planner — the button has to say so
 * before it is pressed.
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
  plan: 'Sends the plan back to a planner with your note; parts nothing has started for are retired',
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

/**
 * The questionnaire an agent raised, or null if it raised none. Defensive for the
 * same reason as {@link agentOptions}: `context` is an open bag whose contents
 * reached us from a model's tool arguments, so an entry without a question is
 * dropped rather than rendered as an empty card nobody can answer.
 */
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
