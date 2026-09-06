import type { OrphanedWork, RecoveryVerdict } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { refLink, relTime } from './util.js';
import { Ref } from './refs.js';
import { HeadRow, Panel } from './panel.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/17-cockpit.md

const VERDICT_HELP: Record<RecoveryVerdict, string> = {
  restore: 'Re-attach to the same Claude conversation in the same worktree; it picks up where it left off',
  requeue: 'Drop that conversation and queue the same work again for a fresh agent, starting from the branch as it is',
  remove: 'Abandon this work. The branch and worktree are left as they are, so nothing is lost from disk',
};

const DIED_LABEL: Record<OrphanedWork['died'], string> = {
  crashed: 'crashed',
  interrupted: 'shut down',
  never_started: 'never started',
};

const DIED_TONE: Record<OrphanedWork['died'], TagTone | undefined> = {
  crashed: 'red',
  interrupted: undefined,
  never_started: 'amber',
};

export function RecoveryPanel({
  crashed,
  now,
  refUrls,
  onDecide,
}: {
  crashed: OrphanedWork[];
  now: number;
  refUrls: Record<string, string>;
  onDecide: (taskId: string, verdict: RecoveryVerdict) => Promise<unknown> | unknown;
}) {
  return (
    <section className="recovery-banner">
      <header>
        <h2>
          <span className="recovery-mark">⏻</span> {crashed.length} task{crashed.length === 1 ? '' : 's'} did not
          survive the last run
        </h2>
        <p>
          The heartbeat is <strong>held</strong> until each of these is decided — nothing new is dispatched, merged or
          reconciled in front of work that was already in flight.
        </p>
      </header>
      {crashed.map((c) => (
        <CrashedCard key={c.taskId} crashed={c} now={now} refUrls={refUrls} onDecide={onDecide} />
      ))}
    </section>
  );
}

function CrashedCard({
  crashed,
  now,
  refUrls,
  onDecide,
}: {
  crashed: OrphanedWork;
  now: number;
  refUrls: Record<string, string>;
  onDecide: (taskId: string, verdict: RecoveryVerdict) => Promise<unknown> | unknown;
}) {
  return (
    <Panel density="padded" className="card crashed">
      <HeadRow className="crashed-head">
        <Tag
          tone={DIED_TONE[crashed.died]}
          fill={DIED_TONE[crashed.died] !== undefined}
          title={VERDICT_CAUSE[crashed.died]}
        >
          {DIED_LABEL[crashed.died]}
        </Tag>
        <strong className="crashed-title">{crashed.title}</strong>
        {crashed.originRef && (
          <span className="muted">
            <Ref to={crashed.originRef} />
          </span>
        )}
        {crashed.branch && <code className="branch">{refLink(crashed.branch, refUrls)}</code>}
      </HeadRow>

      <div className="crashed-meta muted">
        {crashed.died === 'never_started' ? 'queued' : 'started'} {relTime(crashed.startedAt, now)}
        {crashed.detectedAt && ` · found ${relTime(crashed.detectedAt, now)}`}
      </div>

      {/* The one thing an agentless orphan needs said outright: this is not a lost
          conversation, it is a claim on an origin and a branch that nothing was ever
          doing anything about — which is why the fleet has been idle. */}
      {crashed.died === 'never_started' && (
        <p className="crashed-parked">
          No agent was ever started for this task, so no work was done — but while it stands, nothing else can be
          dispatched for its origin{crashed.branch ? ' or its branch' : ''}.
        </p>
      )}

      {/* The two things that say how far it got: its own last account of itself,
          and the question it was parked on. A restore returns to both. */}
      {crashed.note && <p className="crashed-note">“{crashed.note}”</p>}
      {crashed.waitingReason && (
        <p className="crashed-parked">
          Was waiting on you: <em>{crashed.waitingReason}</em>
        </p>
      )}

      <div className="crashed-actions">
        {crashed.restorable ? (
          <AsyncButton tone="primary" title={VERDICT_HELP.restore} onClick={() => onDecide(crashed.taskId, 'restore')}>
            Restore
          </AsyncButton>
        ) : (
          <span className="muted restore-blocked" title={crashed.restoreBlocked ?? undefined}>
            Can’t restore — {crashed.restoreBlocked}
          </span>
        )}
        <AsyncButton title={VERDICT_HELP.requeue} onClick={() => onDecide(crashed.taskId, 'requeue')}>
          Requeue
        </AsyncButton>
        <AsyncButton tone="danger" title={VERDICT_HELP.remove} onClick={() => onDecide(crashed.taskId, 'remove')}>
          Remove
        </AsyncButton>
      </div>
    </Panel>
  );
}

const VERDICT_CAUSE: Record<OrphanedWork['died'], string> = {
  crashed: 'The process disappeared without an ending — a crash, an OOM kill, or a machine that went away',
  interrupted: 'The harness was shut down cleanly and interrupted this agent mid-task',
  never_started:
    'The harness recorded this task and restarted before it could start an agent for it, so nothing ever ran',
};
