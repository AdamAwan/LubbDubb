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
import { ProfilePicker } from './ProfilePicker.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

const TRANSCRIPT_POLL_MS = 5_000;

type AgentDrawerProps = {
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
  profiles: { name: string; description: string }[];
  onLift: (profile: string) => Promise<unknown>;
};

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
  profiles,
  onLift,
}: AgentDrawerProps) {
  const [ejecting, setEjecting] = useState(false);
  const [text, setText] = useState('');
  const send = useAsyncAction();

  const isLive = isLiveStatus(agent.status);
  const { output, files } = useAgentTranscript(agent.id, isLive, live);

  const canRespond = !limitParked && (agent.status === 'waiting' || agent.status === 'running');

  return (
    <Modal face="drawer" label={task ? task.title : agent.id} onClose={onClose}>
      <DrawerHead
        agent={agent}
        task={task}
        refUrls={refUrls}
        isLive={isLive}
        onClose={onClose}
        onKill={onKill}
        onComplete={onComplete}
        onInterrupt={onInterrupt}
        onEjectOpen={onEject !== undefined ? () => setEjecting(true) : undefined}
      />
      {task && hasOriginContext(task) && (
        <OriginContext
          task={task}
          originStandsFor={originStandsFor}
          isLive={isLive}
          profiles={profiles}
          onLift={onLift}
        />
      )}
      {flags && flags.length > 0 && <DrawerFlags flags={flags} artifactUrls={artifactUrls} />}
      {limitParked && <ParkNotice reason={agent.waitingReason} onResume={onResume} />}
      <FilesList files={files} />
      <TranscriptPane text={output} streamId={agent.id} label="Agent transcript" />
      {canRespond && <ReplyForm text={text} setText={setText} send={send} onRespond={onRespond} />}
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

function useAgentTranscript(agentId: string, isLive: boolean, live: string | undefined) {
  const [seed, setSeed] = useState('');
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [liveIsWhole, setLiveIsWhole] = useState(true);
  const held = useRef(0);
  const liveRef = useRef(false);

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
        .getAgentFiles(agentId)
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
        .getTranscript(agentId, held.current)
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
  }, [agentId]);

  const output = liveIsWhole && live !== undefined && live.length > seed.length ? live : seed;
  return { output, files };
}

function DrawerHead({
  agent,
  task,
  refUrls,
  isLive,
  onClose,
  onKill,
  onComplete,
  onInterrupt,
  onEjectOpen,
}: {
  agent: Agent;
  task: TaskSummary | null;
  refUrls: Record<string, string>;
  isLive: boolean;
  onClose: () => void;
  onKill: () => Promise<unknown> | unknown;
  onComplete: () => Promise<unknown> | unknown;
  onInterrupt: () => Promise<unknown> | unknown;
  onEjectOpen: (() => void) | undefined;
}) {
  return (
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
        {isLive && onEjectOpen !== undefined && (
          <Button onClick={onEjectOpen} title="Stop this agent and hold its work for you">
            Eject…
          </Button>
        )}
        {agent.status !== 'done' && (
          <ConfirmButton label="Kill" confirmLabel="Confirm kill" pendingLabel="Killing…" onConfirm={onKill} />
        )}
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function OriginContext({
  task,
  originStandsFor,
  isLive,
  profiles,
  onLift,
}: {
  task: TaskSummary;
  originStandsFor: string | null;
  isLive: boolean;
  profiles: { name: string; description: string }[];
  onLift: (profile: string) => Promise<unknown>;
}) {
  return (
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
          <span className="dispatch-reason-label">Dispatched because</span>
          <span>{task.dispatchReason}</span>
        </div>
      )}
      {/* How this run was launched — the `agentModels` profile its rule resolved
          to at dispatch, and the permission posture it was handed — so reading a
          run says what it cost on and what it was allowed to do unattended. One
          row of facts: each is a small reading, none is what the operator opened
          the drawer for. Drawn from the stored values, never recomputed against
          today's config: the policy moves, and a finished run must keep saying
          what it was dispatched under. */}
      {(task.model || task.permissionMode) && (
        <DispatchMeta task={task} isLive={isLive} profiles={profiles} onLift={onLift} />
      )}
    </div>
  );
}

function profileSourceTitle(source: TaskSummary['profileSource']): string {
  if (source === 'pin')
    return 'Pinned — this goal, its plan, or the Up next row it was priced on named this profile rather than taking its rule’s';
  if (source === 'rule') return 'This dispatch rule’s own profile';
  return 'The fleet default, for a rule with no profile of its own';
}

function DispatchMeta({
  task,
  isLive,
  profiles,
  onLift,
}: {
  task: TaskSummary;
  isLive: boolean;
  profiles: { name: string; description: string }[];
  onLift: (profile: string) => Promise<unknown>;
}) {
  return (
    <div className="dispatch-meta">
      {/* Model and effort are one profile's two halves and read as one fact;
          an effort with no model is not a state the resolver can produce. */}
      {task.model && (
        <span className="dispatch-fact">
          <span className="dispatch-reason-label">Model</span>
          <span>
            {task.model}
            {task.effort && ` · ${task.effort} effort`}
          </span>
        </span>
      )}
      {task.permissionMode && (
        <span className="dispatch-fact">
          <span className="dispatch-reason-label">Permission</span>
          <span title="The permission mode this agent was launched under">{task.permissionMode}</span>
        </span>
      )}
      {/* Which profile, and which level of the chain named it (#342). A
          pinned run cost what somebody chose for this goal rather than
          what its rule prices — and a bumped agent that reads as an
          ordinary one is the invisible half of pinning. */}
      {task.profile && (
        <Tag tone={task.profileSource === 'pin' ? 'amber' : undefined} title={profileSourceTitle(task.profileSource)}>
          {task.profile}
          {task.profileSource === 'pin' ? ' · pinned' : ''}
        </Tag>
      )}
      {/* Lifting a live run to a deeper profile (#356). The picker is here,
          beside what the run is costing, because that reading is what makes
          an operator reach for it — the job turned out harder than the
          profile its rule priced it at. It stops this agent and re-opens its
          conversation on the chosen profile, so it is drawn only while there
          is a conversation to carry. */}
      {isLive && (
        <ProfilePicker
          profiles={profiles}
          value={task.profile ?? null}
          defaultProfile={null}
          inheritLabel="Lift to…"
          onPick={(profile) => {
            if (profile !== null && profile !== task.profile) void onLift(profile);
          }}
        />
      )}
    </div>
  );
}

function hasOriginContext(task: TaskSummary): boolean {
  return Boolean(task.originTitle || task.originSummary || task.dispatchReason || task.model || task.permissionMode);
}

function ParkNotice({
  reason,
  onResume,
}: {
  reason: Agent['waitingReason'];
  onResume: () => Promise<unknown> | unknown;
}) {
  return (
    <div className="park-notice">
      <b>Parked on a usage limit.</b> {reason ?? 'This account has no usage allowance left right now.'}
      <AsyncButton tone="primary" onClick={onResume} pendingLabel="Resuming…">
        Resume
      </AsyncButton>
    </div>
  );
}

function ReplyForm({
  text,
  setText,
  send,
  onRespond,
}: {
  text: string;
  setText: (text: string) => void;
  send: ReturnType<typeof useAsyncAction>;
  onRespond: (text: string) => Promise<unknown>;
}) {
  return (
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
  );
}

function isLiveStatus(status: Agent['status']): boolean {
  return status === 'running' || status === 'waiting' || status === 'starting';
}

function DrawerFlags({ flags, artifactUrls }: { flags: AgentFlag[]; artifactUrls: Record<string, string> }) {
  return (
    <div className="drawer-flags">
      <span className="drawer-flags-label">Artifacts</span>
      <FlagChips flags={flags} artifactUrls={artifactUrls} />
    </div>
  );
}
