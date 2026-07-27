import type { CrashedAgent, RecoveryVerdict } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { refLink, relTime } from './util.js';

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

/**
 * The blocking recovery screen: every agent the last run left orphaned, and the
 * three things that can be done with each.
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
 * no restore here" is precisely the question this screen exists to pre-empt.
 */
export function RecoveryPanel({
  crashed,
  now,
  refUrls,
  onDecide,
}: {
  crashed: CrashedAgent[];
  now: number;
  refUrls: Record<string, string>;
  onDecide: (agentId: string, verdict: RecoveryVerdict) => Promise<unknown> | unknown;
}) {
  return (
    <section className="recovery-banner">
      <header>
        <h2>
          <span className="recovery-mark">⏻</span> {crashed.length} agent{crashed.length === 1 ? '' : 's'} did not
          survive the last run
        </h2>
        <p>
          The heartbeat is <strong>held</strong> until each of these is decided — nothing new is dispatched, merged or
          reconciled in front of work that was already in flight.
        </p>
      </header>
      {crashed.map((c) => (
        <CrashedCard key={c.agentId} crashed={c} now={now} refUrls={refUrls} onDecide={onDecide} />
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
  crashed: CrashedAgent;
  now: number;
  refUrls: Record<string, string>;
  onDecide: (agentId: string, verdict: RecoveryVerdict) => Promise<unknown> | unknown;
}) {
  return (
    <div className="card crashed">
      <div className="crashed-head">
        <span className={`badge ${crashed.died}`} title={VERDICT_CAUSE[crashed.died]}>
          {crashed.died === 'crashed' ? 'crashed' : 'shut down'}
        </span>
        <strong className="crashed-title">{crashed.title}</strong>
        {crashed.originRef && <span className="muted">{refLink(crashed.originRef, refUrls)}</span>}
        {crashed.branch && <code className="branch">{crashed.branch}</code>}
      </div>

      <div className="crashed-meta muted">
        started {relTime(crashed.startedAt, now)}
        {crashed.detectedAt && ` · found ${relTime(crashed.detectedAt, now)}`}
      </div>

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
          <AsyncButton
            className="primary"
            title={VERDICT_HELP.restore}
            onClick={() => onDecide(crashed.agentId, 'restore')}
          >
            Restore
          </AsyncButton>
        ) : (
          <span className="muted restore-blocked" title={crashed.restoreBlocked ?? undefined}>
            Can’t restore — {crashed.restoreBlocked}
          </span>
        )}
        <AsyncButton title={VERDICT_HELP.requeue} onClick={() => onDecide(crashed.agentId, 'requeue')}>
          Requeue
        </AsyncButton>
        <AsyncButton className="danger" title={VERDICT_HELP.remove} onClick={() => onDecide(crashed.agentId, 'remove')}>
          Remove
        </AsyncButton>
      </div>
    </div>
  );
}

/** Why this agent is here at all — the tooltip on the cause badge. */
const VERDICT_CAUSE: Record<CrashedAgent['died'], string> = {
  crashed: 'The process disappeared without an ending — a crash, an OOM kill, or a machine that went away',
  interrupted: 'The harness was shut down cleanly and interrupted this agent mid-task',
};
