import type { Agent, AgentFlag, Task } from '../../../types.js';
import { statusDot, elapsed, linkify, refLink, relTime, agentUsageLine } from '../../../components/util.js';
import { ConfirmButton } from '../../../components/ConfirmButton.js';
import { FlagChips } from '../../../components/FlagChips.js';

export function AgentCard({
  agent,
  task,
  now,
  refUrls,
  lastLine,
  flags,
  artifactUrls,
  onOpen,
  onKill,
  onComplete,
  past,
}: {
  agent: Agent;
  task: Task | null;
  now: number;
  refUrls: Record<string, string>;
  lastLine?: string;
  flags?: AgentFlag[];
  artifactUrls: Record<string, string>;
  onOpen: () => void;
  onKill?: () => Promise<unknown> | unknown;
  /** Declare the work finished: the clean terminal an agent reaches with a done sentinel. */
  onComplete?: () => Promise<unknown> | unknown;
  past?: boolean;
}) {
  const active = agent.status === 'running' || agent.status === 'starting';
  const usage = agentUsageLine(agent);
  return (
    <div className={`card agent ${agent.status} ${past ? 'past' : ''}`}>
      <div className="card-head" onClick={onOpen}>
        {statusDot(agent.status)}
        <span className="card-title">{task ? linkify(task.title, refUrls) : agent.taskId}</span>
        <span className="chip small">{task?.kind ?? '—'}</span>
      </div>
      <div className="card-meta">
        <span className={`badge ${agent.status}`}>
          {active && <span className="spinner" aria-hidden />}
          {agent.status}
        </span>
        {task?.branch && <span className="mono">{refLink(task.branch, refUrls)}</span>}
        <span className="muted mono-time">{elapsed(agent.startedAt, agent.endedAt, now)}</span>
        {usage && (
          <span className="muted mono-time" title="Claude cost · input→output tokens · turns (cumulative)">
            {usage}
          </span>
        )}
      </div>
      {agent.waitingReason && (
        <div className="waiting-reason">
          ⏳ {agent.waitingReason}
          {/*
            Parking is a request, not a stop: the `escalate` tool returns at once, so
            an agent that kept calling tools is working while this card says waiting.
            Said here rather than resolved, because only the reader knows whether the
            question still matters — the Dismiss button is the other half.
          */}
          {agent.resumedAt && (
            <span className="chip small ok" title={`Last tool call ${relTime(agent.resumedAt, now)}`}>
              working anyway
            </span>
          )}
        </div>
      )}
      <FlagChips flags={flags} artifactUrls={artifactUrls} />
      {/*
        The agent's own account of what it is doing, and beneath it the raw output
        tail. Both, never one instead of the other: the note is a claim (durable,
        attributed, and as old as its timestamp says), the tail is evidence that
        output is still coming out. An agent that never calls `note_progress`
        leaves a card identical to the one before the tool existed.

        The age is shown so the note can be read as current or not. It is not a
        health signal and is deliberately not styled as one — a long gap usually
        means a long step, not a stuck agent.
      */}
      {agent.note && (
        <div className="progress-note">
          <span className="progress-note-text">{agent.note}</span>
          {agent.notedAt && <span className="progress-note-age">{relTime(agent.notedAt, now)}</span>}
        </div>
      )}
      {active && lastLine && <div className="last-line mono">{lastLine}</div>}
      <div className="card-actions">
        <button className="btn" onClick={onOpen}>
          Open
        </button>
        {/*
          Two ways to end an agent, and they say opposite things. Done is for an
          agent that finished but never printed the sentinel: the task reads done
          and the worktree is reclaimed. Kill is an abandonment — the task reads
          interrupted and the checkout is kept for triage. Both are confirm-gated
          because both stop a live process.
        */}
        {onComplete && agent.status !== 'done' && (
          <ConfirmButton
            label="Mark done"
            confirmLabel="Confirm done"
            pendingLabel="Finishing…"
            onConfirm={onComplete}
          />
        )}
        {onKill && agent.status !== 'done' && (
          <ConfirmButton label="Kill" confirmLabel="Confirm kill" pendingLabel="Killing…" onConfirm={onKill} />
        )}
      </div>
    </div>
  );
}
