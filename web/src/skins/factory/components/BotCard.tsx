import type { JSX } from 'react';
import type { Agent, AgentFlag, Task } from '../../../types.js';
import { FlagChips } from '../../../components/FlagChips.js';
import { ConfirmButton } from '../../../components/ConfirmButton.js';
import { agentUsageLine, elapsed, refChip, relTime } from '../../../components/util.js';
import { Icon } from './Sprite.js';
import { botState, clip, iconForOrigin } from '../vocabulary.js';

/**
 * One bot, and what it last said it was doing.
 *
 * The line under the title is `note_progress` when the agent wrote one and the
 * output tail otherwise — the same order Classic uses, and for the same reason:
 * a note is a claim the agent made, the tail is only evidence it is still
 * emitting. The quotation marks are drawn by CSS on the note alone, so a tail is
 * never dressed up as something the agent said.
 *
 * A bot with an open question carries it (#245): the alerts gauge is the right
 * place to learn that *something* needs you, and the wrong place to be the only
 * one — an operator watching the floor should not have to leave it to find out
 * which bot is waiting, or to answer. The card itself is passed in already wired
 * rather than built here, so the floor and the desk draw one component owning one
 * set of refusal rules.
 */
export function BotCard({
  agent,
  task,
  now,
  lastLine,
  flags,
  escalation,
  artifactUrls,
  refUrls,
  onOpen,
  onKill,
  onComplete,
  past = false,
}: {
  agent: Agent;
  task: Task | null;
  now: number;
  lastLine?: string;
  flags?: AgentFlag[];
  /** The wired `EscalationCard` for the question this bot asked, if one is open. */
  escalation?: JSX.Element;
  artifactUrls: Record<string, string>;
  refUrls: Record<string, string>;
  onOpen(): void;
  onKill?: () => Promise<void>;
  onComplete?: () => Promise<void>;
  past?: boolean;
}): JSX.Element {
  const state = botState(agent);
  // Keyed off the question, never off `agent.status`: parking is only a request,
  // so an agent that carried on working still owes an answer — and a bot that
  // stopped reading as asking while the desk still listed the item would be the
  // two surfaces disagreeing. `EscalationCard`'s own `agent resumed` chip is what
  // says which of the two is happening.
  const asking = escalation !== undefined;
  const origin = task?.originRef ?? null;
  const spoke = agent.note?.trim();

  return (
    <article className={`fx-bot fx-sunk ${asking || state === 'idle' ? 'idle' : ''} ${past ? 'spent' : ''}`}>
      <div className="fx-bot-top">
        <Icon name={asking || state === 'idle' ? 'alert' : iconForOrigin(origin)} />
        <span className="fx-job" title={task?.title ?? agent.id}>
          {asking ? 'Asking you' : state === 'idle' ? 'Idle — needs you' : (task?.title ?? agent.id)}
        </span>
        <span className="fx-ref">
          {/* The origin links when the provider resolved it, else it stays the
              plain clipped ref — refChip falls back to null, never a dead link. */}
          {origin
            ? (refChip(origin, clip(origin, 24), refUrls, { className: 'ext-ref', title: origin }) ?? clip(origin, 24))
            : agent.status}{' '}
          · {elapsed(agent.startedAt, agent.endedAt, now)}
        </span>
      </div>

      {/* The reason the agent gave when it parked. Dropped when the question
          itself is on the card below, where it is the same sentence with the
          options and the answer box attached to it. */}
      {!asking && state === 'idle' && agent.waitingReason && <p className="fx-say">{agent.waitingReason}</p>}
      {spoke ? (
        <p className="fx-say" title={agent.notedAt ? `said ${relTime(agent.notedAt, now)}` : undefined}>
          {spoke}
        </p>
      ) : (
        lastLine && <p>{lastLine}</p>
      )}

      <FlagChips flags={flags} artifactUrls={artifactUrls} />

      {/* A wrapper of this skin's own, because the shared card is tinted through
          tokens and never reached into by class — all this owns is the gap. */}
      {escalation && <div className="fx-ask">{escalation}</div>}

      <div className="fx-acts">
        <button type="button" className="fx-btn" onClick={onOpen}>
          Transcript
        </button>
        {onComplete && (
          <ConfirmButton
            className="fx-btn go"
            label="Mark done"
            confirmLabel="Sure?"
            title="Stop it cleanly and record the run as finished — the worktree is removed"
            onConfirm={onComplete}
          />
        )}
        {onKill && (
          <ConfirmButton
            className="fx-btn no"
            label="Recall"
            confirmLabel="Sure?"
            title="Kill the process — the task is recorded interrupted and the worktree kept"
            onConfirm={onKill}
          />
        )}
      </div>

      {past && agentUsageLine(agent) && <p className="fx-empty">{agentUsageLine(agent)}</p>}
    </article>
  );
}
