import { useState, type JSX } from 'react';
import type { Proposal } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { QuestionnaireModal } from './QuestionnaireModal.js';
import { CaveatChecklist, heldTitle, useAcknowledgements } from './CaveatChecklist.js';
import { useCheckDeclines } from './CheckSetAsk.js';
import { PlanAnswers } from './PlanAnswers.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { readCard, type Card, type CardProps } from './escalationReading.js';
import {
  AgentActions,
  CardDetail,
  CardHead,
  CardProse,
  DismissRow,
  PlanOpen,
  QuickAnswers,
} from './EscalationParts.js';

// → docs/spec/17-cockpit.md

type Acknowledgements = ReturnType<typeof useAcknowledgements>;
type Declines = ReturnType<typeof useCheckDeclines>;
type Send = ReturnType<typeof useAsyncAction>;

export function EscalationCard(props: CardProps) {
  const { escalation, now, refUrls, onAnswerQuestions } = props;
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const send = useAsyncAction();
  const card = readCard(props);
  const { permission, questions } = card;
  const ack = useAcknowledgements(card.caveats);
  /* The rows the operator is striking out of the set. Held on the card rather than in `CheckSetAsk`,
     because the control is drawn on the row and the verdict is sent by the button at the foot.
     → docs/spec/20-validation.md#declining-a-single-row */
  const declines = useCheckDeclines(card.checkSet);

  return (
    <Panel density="padded" className="card escalation">
      <CardHead escalation={escalation} card={card} resumedAt={props.resumedAt} now={now} refUrls={refUrls} />
      <CardProse escalation={escalation} card={card} refUrls={refUrls} />
      <CardDetail escalation={escalation} card={card} refUrls={refUrls} declines={declines} />

      {/*
        Both act on the *agent*, not on the question — which is why "Mark work
        done" sits here beside the transcript link rather than among the quick
        answers below. A quick answer routes through `answer` -> `agents.respond`,
        which types text into the session and flips the agent back to running: the
        opposite of finishing it. This ends the agent on the done terminal and
        settles this item on the way out.
      */}
      {escalation.agentId ? (
        <AgentActions
          agentId={escalation.agentId}
          expiring={card.expiring}
          onOpenAgent={props.onOpenAgent}
          onComplete={props.onComplete}
          onExtend={props.onExtend}
        />
      ) : null}

      <PlanOpen card={card} onViewPlan={props.onViewPlan} />

      {permission ? <pre className="esc-output">{permission.summary}</pre> : null}

      <QuickAnswers card={card} onAnswer={props.onAnswer} />

      <CardAnswer
        props={props}
        card={card}
        text={text}
        setText={setText}
        send={send}
        ack={ack}
        declines={declines}
        onAsk={() => setAsking(true)}
      />

      <DismissRow card={card} escalationId={escalation.id} text={text} onDismiss={props.onDismiss} />

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

interface AnswerProps {
  props: CardProps;
  card: Card;
  text: string;
  setText: (text: string) => void;
  send: Send;
  ack: Acknowledgements;
  declines: Declines;
  onAsk: () => void;
}

function CardAnswer(answer: AnswerProps): JSX.Element {
  const { props, card, text, setText, send, onAsk } = answer;
  const { escalation, onPermission, onReveal, onAnswer } = props;
  if (card.permission)
    return (
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
    );
  if (card.gated)
    return (
      <Button className="esc-plan-open" onClick={onReveal}>
        <span className="esc-plan-open-label">Reveal the plan</span>
        <span className="esc-plan-open-hint">
          the prediction and what “done” means are asked first, on the goal — then it is yours to read →
        </span>
      </Button>
    );
  if (card.decidable) return <DecisionAnswer {...answer} decidable={card.decidable} />;
  if (card.questions)
    return (
      <div className="esc-quick">
        <AsyncButton tone="primary" onClick={onAsk}>
          Answer {card.questions.length} questions →
        </AsyncButton>
      </div>
    );
  return (
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
  );
}

function DecisionAnswer(answer: AnswerProps & { decidable: Proposal }): JSX.Element {
  const { props, card, ack, decidable } = answer;
  const { refUrls, desktopFolder, onDecide, onBackOut, onViewPlan } = props;
  const { caveats, planDecidable, planId, issueNumber } = card;
  const held = ack.outstanding.length > 0;
  return (
    <>
      <CaveatChecklist
        caveats={caveats}
        ticked={ack.ticked}
        answers={ack.written}
        onToggle={ack.toggle}
        onAnswer={ack.answer}
        refUrls={refUrls}
      />
      {planDecidable ? (
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
      ) : (
        <VerdictRow {...answer} decidable={decidable} held={held} />
      )}
    </>
  );
}

function VerdictRow({
  props,
  card,
  text,
  setText,
  ack,
  declines,
  decidable,
  held,
}: AnswerProps & { decidable: Proposal; held: boolean }): JSX.Element {
  const { onDecide, onOverrule } = props;
  const { overrulable } = card;
  return (
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
        disabled={held || declines.unsaid.length > 0}
        title={acceptTitle(decidable, held, ack, declines)}
        onClick={() =>
          onDecide!(decidable.id, 'accept', text.trim() || undefined, ack.acknowledged, ack.answers, declines.declined)
        }
      >
        {declines.whole ? 'Send them back' : (ACCEPT_LABEL[decidable.kind] ?? 'Approve')}
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
  );
}

function acceptTitle(decidable: Proposal, held: boolean, ack: Acknowledgements, declines: Declines): string {
  if (declines.unsaid.length > 0) return unsaidTitle(declines.unsaid);
  if (declines.whole) return 'You have struck out every check, so this sends them back to be written again';
  if (held) return heldTitle(ack.outstanding);
  return ACCEPT_HINT[decidable.kind] ?? 'Authorize this act now';
}

const ACCEPT_LABEL: Record<string, string> = {
  merge: 'Approve merge',
  reply_draft: 'Approve & send',
  plan: 'Approve plan',
  validation_plan: 'Use these checks',
};
const ACCEPT_HINT: Record<string, string> = {
  validation_plan: 'Release these checks — the bench draws them and a check you hand to the fleet can be dispatched',
  merge: 'Merge it now',
  reply_draft: 'Send this reply now',
  plan: 'Release the plan — each part gets its own agent, branch and PR',
};
const REJECT_HINT: Record<string, string> = {
  merge: "Nothing goes out, and the harness won't ask again",
  reply_draft: "Nothing goes out, and the harness won't ask again",
  plan: 'Sends the plan back to a planner with your note; parts nothing has started for are retired',
  validation_plan: 'Sends these back to be written again with your note; the checks stay, to be reworded',
};

/**
 * A declined row with nothing typed against it holds the press, and says so. The route refuses a
 * reasonless decline; a button that let the click through would put that refusal in front of somebody
 * with no way to have seen it coming. → docs/spec/20-validation.md#declining-a-single-row
 */
function unsaidTitle(unsaid: readonly string[]): string {
  return unsaid.length === 1
    ? `Say why ${unsaid[0]} is not worth running — a decline carries your reason`
    : `Say why ${unsaid.join(', ')} are not worth running — a decline carries your reason`;
}
