import { useEffect, useRef, useState } from 'react';
import type { Agent, AgentFile, AgentFlag, TaskSummary } from '../types.js';
import { api } from '../api.js';
import { statusDot, linkify, agentUsageLine } from './util.js';
import { Ref } from './refs.js';
import { ConfirmButton } from './ConfirmButton.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { FlagChips } from './FlagChips.js';
import { Modal } from './Modal.js';
import { EjectModal } from './Ejection.js';
import { FilesList } from './FilesList.js';
import { TranscriptPane } from './TranscriptPane.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

const TRANSCRIPT_POLL_MS = 5_000;

export function AgentDrawer({
  agent,
  task,
  originStandsFor,
  refUrls,
  live,
  flags,
  artifactUrls,
  limitParked,
  onClose,
  onRespond,
  onKill,
  onEject,
  onComplete,
  onInterrupt,
  onResume,
}: {
  agent: Agent;
  task: TaskSummary | null;
  originStandsFor: string | null;
  refUrls: Record<string, string>;
  live: string | undefined;
  flags?: AgentFlag[];
  artifactUrls: Record<string, string>;
  limitParked: boolean;
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => Promise<unknown> | unknown;
  onEject?: (reason: string) => Promise<unknown>;
  onComplete: () => Promise<unknown> | unknown;
  onInterrupt: () => Promise<unknown> | unknown;
  onResume: () => Promise<unknown> | unknown;
}) {
  const [seed, setSeed] = useState('');
  const [ejecting, setEjecting] = useState(false);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [liveIsWhole, setLiveIsWhole] = useState(true);
  const [text, setText] = useState('');
  const send = useAsyncAction();
  const held = useRef(0);
  const liveRef = useRef(false);

  const isLive = agent.status === 'running' || agent.status === 'waiting' || agent.status === 'starting';
  useEffect(() => {
    liveRef.current = isLive;
  }, [isLive]);

  useEffect(() => {
    let active = true;
    let seeded = false;
    held.current = 0;
    setSeed('');
    setFiles([]);
    setLiveIsWhole(true);
    const readFiles = (): void => {
      void api
        .getAgentFiles(agent.id)
        .then((r) => {
          if (active) setFiles(r.files);
        })
        .catch(() => {});
    };
    let reading = false;
    const read = (): void => {
      if (reading) return;
      reading = true;
      void api
        .getTranscript(agent.id, held.current)
        .then((r) => {
          if (!active) return;
          if (!seeded) {
            seeded = true;
            setLiveIsWhole(r.total === 0);
          }
          held.current = r.total;
          if (r.transcript || r.from === 0) setSeed((prev) => (r.from === 0 ? r.transcript : prev + r.transcript));
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    };
    read();
    readFiles();
    const timer = setInterval(() => {
      if (liveRef.current || !seeded) read();
      if (liveRef.current) readFiles();
    }, TRANSCRIPT_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [agent.id]);

  const output = liveIsWhole && live !== undefined && live.length > seed.length ? live : seed;

  const canRespond = !limitParked && (agent.status === 'waiting' || agent.status === 'running');

  return (
    <Modal face="drawer" label={task ? task.title : agent.id} onClose={onClose}>
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
          {/* Drawn between the two that cost nothing and the one that throws the
              conversation away, in the order of what each costs. */}
          {isLive && onEject !== undefined && (
            <Button onClick={() => setEjecting(true)} title="Stop this agent and hold its work for you">
              Eject…
            </Button>
          )}
          {agent.status !== 'done' && (
            <ConfirmButton label="Kill" confirmLabel="Confirm kill" pendingLabel="Killing…" onConfirm={onKill} />
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
      {task && (task.originTitle || task.originSummary || task.dispatchReason || task.model) && (
        <div className="origin-context">
          {task.originTitle && (
            <div className="origin-title">
              {/* The way back to what this agent was sent at — a goal's page,
                    or the pull request when no ticket owns the work. */}
              {task.originRef && (
                <Tag>
                  <Ref to={task.originRef} />
                </Tag>
              )}
              {/* A job id says nothing about the work, so a requeue also names
                    what it stands in for. */}
              {originStandsFor !== null && originStandsFor !== task.originRef && (
                <Tag>
                  <Ref to={originStandsFor} />
                </Tag>
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
                <Tag
                  tone={task.profileSource === 'pin' ? 'amber' : undefined}
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
                </Tag>
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
          <b>Parked on a usage limit.</b> {agent.waitingReason ?? 'This account has no usage allowance left right now.'}
          <AsyncButton tone="primary" onClick={onResume} pendingLabel="Resuming…">
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
            logUsage('agent.send');
            void send.run(async () => {
              await onRespond(value);
              setText('');
            });
          }}
        >
          <input placeholder="Type into this agent…" value={text} onChange={(e) => setText(e.target.value)} />
          <SubmitButton phase={send.phase} tone="primary">
            Send
          </SubmitButton>
        </form>
      )}
      {ejecting && onEject !== undefined && (
        <EjectModal
          agentId={agent.id}
          title={task ? task.title : agent.id}
          onEject={onEject}
          onClose={() => setEjecting(false)}
        />
      )}
    </Modal>
  );
}
