import type { OrphanedWork, RecoveryVerdict } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { refLink, relTime } from './util.js';
import { Ref } from './refs.js';
import { HeadRow, Panel } from './panel.js';

/**
 * What each verdict does, in the operator's terms. These are the whole of the
 * screen's argument, so they say the consequence rather than the mechanism —
 * "picks up where it left off" is the thing being chosen, `claude --resume` is not.
 */
const VERDICT_HELP: Record<RecoveryVerdict, string> = {
  restore: 'Re-attach to the same Claude conversation in the same worktree; it picks up where it left off',
  requeue: 'Drop that conversation and queue the same work again for a fresh agent, starting from the branch as it is',
  remove: 'Abandon this work. The branch and worktree are left as they are, so nothing is lost from disk',
};

/** What the cause badge says, per way a run failed to end. */
const DIED_LABEL: Record<OrphanedWork['died'], string> = {
  crashed: 'crashed',
  interrupted: 'shut down',
  never_started: 'never started',
};

/**
 * The blocking recovery screen: every piece of work the last run left orphaned, and
 * the three things that can be done with each.
 *
 * **It is a banner, not a panel, because the harness is doing nothing while it is
 * up.** A pulse held on an undecided fleet means no dispatch, no merges, no plan
 * reconciliation — so every other surface on the page is stale in the same way for
 * the same reason, and one card among the findings would leave an operator hunting
 * for why their fleet is frozen. The count and the "nothing else is running" line
 * are the two facts that stop that hunt before it starts.
 *
 * Restore is offered only when it can actually be done, and when it cannot the card
 * says why (`restoreBlocked`) rather than hiding the button silently: "why is there
 * no restore here" is precisely the question this screen exists to pre-empt. A
 * `never_started` orphan is the case with no agent at all, so it always reads that
 * way — there is no conversation to go back to, only requeue and remove.
 */
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
        <span className={`badge ${crashed.died}`} title={VERDICT_CAUSE[crashed.died]}>
          {DIED_LABEL[crashed.died]}
        </span>
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

/** Why this work is here at all — the tooltip on the cause badge. */
const VERDICT_CAUSE: Record<OrphanedWork['died'], string> = {
  crashed: 'The process disappeared without an ending — a crash, an OOM kill, or a machine that went away',
  interrupted: 'The harness was shut down cleanly and interrupted this agent mid-task',
  never_started:
    'The harness recorded this task and restarted before it could start an agent for it, so nothing ever ran',
};
