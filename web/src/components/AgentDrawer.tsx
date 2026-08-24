import { useEffect, useState } from 'react';
import type { Agent, AgentFile, AgentFlag, TaskSummary } from '../types.js';
import { api } from '../api.js';
import { statusDot, linkify, agentUsageLine } from './util.js';
import { Ref } from './refs.js';
import { ConfirmButton } from './ConfirmButton.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { FlagChips } from './FlagChips.js';
import { FilesList } from './FilesList.js';
import { TranscriptPane } from './TranscriptPane.js';

/**
 * The drill-down: the transcript for one agent, rendered in the shared
 * {@link TranscriptPane}, plus a box to type a response straight into its session.
 * Seeds from the persisted transcript, then appends live deltas streamed over the
 * socket.
 */
export function AgentDrawer({
  agent,
  task,
  refUrls,
  live,
  flags,
  artifactUrls,
  files,
  limitParked,
  onClose,
  onRespond,
  onKill,
  onComplete,
  onInterrupt,
  onResume,
}: {
  agent: Agent;
  task: TaskSummary | null;
  refUrls: Record<string, string>;
  live: string | undefined;
  flags?: AgentFlag[];
  artifactUrls: Record<string, string>;
  files?: AgentFile[];
  /** Parked because the account's usage limit is spent, not because it asked anything. */
  limitParked: boolean;
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => Promise<unknown> | unknown;
  /** Declare the work finished: the clean terminal an agent reaches with a done sentinel. */
  onComplete: () => Promise<unknown> | unknown;
  onInterrupt: () => Promise<unknown> | unknown;
  /** End a usage-limit park: re-open the conversation and carry on. */
  onResume: () => Promise<unknown> | unknown;
}) {
  const [seed, setSeed] = useState('');
  const [text, setText] = useState('');
  const send = useAsyncAction();

  useEffect(() => {
    let active = true;
    api
      .getTranscript(agent.id)
      .then((r) => active && setSeed(r.transcript))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agent.id]);

  // Same output value as before: prefer the live stream once it overtakes the seed.
  const output = live !== undefined && live.length > seed.length ? live : seed;

  // A limit park takes the reply box away rather than leaving one that cannot send:
  // the process is usually gone with the limit, so typing here would reach nothing —
  // and there is no question on the other end of it to answer.
  const canRespond = !limitParked && (agent.status === 'waiting' || agent.status === 'running');
  const isLive = agent.status === 'running' || agent.status === 'waiting' || agent.status === 'starting';

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            {statusDot(agent.status)} <b>{task ? linkify(task.title, refUrls) : agent.id}</b>
            <div className="muted small mono">{agent.cwd}</div>
            {agentUsageLine(agent) && (
              <div className="muted small mono" title="Claude cost · input→output tokens · turns (cumulative)">
                {agentUsageLine(agent)}
              </div>
            )}
          </div>
          <div>
            {isLive && (
              <AsyncButton
                onClick={onInterrupt}
                title="Send Ctrl-C"
                pendingLabel={<span className="spinner" aria-hidden />}
              >
                Interrupt ⌃C
              </AsyncButton>
            )}
            {isLive && (
              <ConfirmButton
                label="Mark done"
                confirmLabel="Confirm done"
                pendingLabel="Finishing…"
                onConfirm={onComplete}
              />
            )}
            {agent.status !== 'done' && (
              <ConfirmButton label="Kill" confirmLabel="Confirm kill" pendingLabel="Killing…" onConfirm={onKill} />
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {task && (task.originTitle || task.originSummary || task.dispatchReason || task.model) && (
          <div className="origin-context">
            {task.originTitle && (
              <div className="origin-title">
                {/* The way back to what this agent was sent at — a goal's page,
                    or the pull request when no ticket owns the work. */}
                {task.originRef && (
                  <span className="chip small">
                    <Ref to={task.originRef} />
                  </span>
                )}
                <span>{task.originTitle}</span>
              </div>
            )}
            {task.originSummary && <div className="origin-summary">{task.originSummary}</div>}
            {task.dispatchReason && (
              <div className="dispatch-reason">
                <span className="dispatch-reason-label">Dispatched because</span> {task.dispatchReason}
              </div>
            )}
            {/* What this run was launched on — the `agentModels` profile its rule
                resolved to at dispatch, so reading a run says what it cost on.
                Model and effort are one profile's two halves and read as one line;
                an effort with no model is not a state the resolver can produce. */}
            {task.model && (
              <div className="dispatch-model">
                <span className="dispatch-reason-label">Model</span> {task.model}
                {task.effort && ` · ${task.effort} effort`}
                {/* Which profile, and which level of the chain named it (#342). A
                    pinned run cost what somebody chose for this goal rather than
                    what its rule prices — and a bumped agent that reads as an
                    ordinary one is the invisible half of pinning. Drawn from the
                    stored source, never recomputed against today's config: the
                    policy moves, and a finished run must keep saying what it was
                    dispatched under. */}
                {task.profile && (
                  <span
                    className={`chip small${task.profileSource === 'pin' ? ' warn' : ''}`}
                    title={
                      task.profileSource === 'pin'
                        ? 'Pinned — this goal, its plan, or the Up next row it was priced on named this profile rather than taking its rule’s'
                        : task.profileSource === 'rule'
                          ? 'This dispatch rule’s own profile'
                          : 'The fleet default, for a rule with no profile of its own'
                    }
                  >
                    {task.profile}
                    {task.profileSource === 'pin' ? ' · pinned' : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {flags && flags.length > 0 && (
          <div className="drawer-flags">
            <span className="drawer-flags-label">Artifacts</span>
            <FlagChips flags={flags} artifactUrls={artifactUrls} />
          </div>
        )}
        {limitParked && (
          <div className="park-notice">
            <b>Parked on a usage limit.</b>{' '}
            {agent.waitingReason ?? 'This account has no usage allowance left right now.'}
            <AsyncButton className="primary" onClick={onResume} pendingLabel="Resuming…">
              Resume
            </AsyncButton>
          </div>
        )}
        <FilesList files={files} />
        <TranscriptPane text={output} streamId={agent.id} label="Agent transcript" />
        {canRespond && (
          <form
            className="reply"
            onSubmit={(e) => {
              e.preventDefault();
              const value = text.trim();
              if (!value) return;
              void send.run(async () => {
                await onRespond(value);
                setText('');
              });
            }}
          >
            <input placeholder="Type into this agent…" value={text} onChange={(e) => setText(e.target.value)} />
            <SubmitButton phase={send.phase} className="primary">
              Send
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}
