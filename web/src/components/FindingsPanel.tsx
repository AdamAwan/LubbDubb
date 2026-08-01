import type { Finding } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { refLink, relTime } from './util.js';

/** What each kind means, in the operator's terms — the chip's tooltip. */
const KIND_HELP: Record<Finding['kind'], string> = {
  duplicate: 'The reporting agent believes this is the same work as another item',
  blocked: 'The fix needs a change outside what the agent could touch',
  out_of_scope: 'Something real the agent found that was not its task',
};

/**
 * What agents noticed outside their own tasks. Before `report_finding` these went
 * into a PR comment and hoped a human read them; the point of the panel is that
 * this is now the place they land, so a finding nobody sees is not the PR comment
 * it replaced.
 *
 * The buttons are the *only* way a finding becomes anything. Nothing in the
 * dispatcher reads findings, deliberately: an agent that could queue jobs could
 * put agents on the fleet, so every transition is the operator's click. "Queue
 * job" turns one into an ordinary queued job (dispatched by rule `manual-job` like any
 * other) — do it now; "File ticket" puts it in the tracker so it can wait its
 * turn there — defer it; "Dismiss" records that it was read and needs nothing.
 */
export function FindingsPanel({
  findings,
  now,
  refUrls,
  canFileTickets,
  onPromote,
  onFile,
  onDismiss,
}: {
  findings: Finding[];
  now: number;
  refUrls: Record<string, string>;
  /** False when no real tracker is configured — there is nowhere to file into. */
  canFileTickets: boolean;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onFile: (id: string) => Promise<unknown> | unknown;
  onDismiss: (id: string) => Promise<unknown> | unknown;
}) {
  if (findings.length === 0) {
    return <p className="empty">Nothing reported — agents have found nothing outside their own tasks.</p>;
  }
  // Open first (they're the ones that want a decision), then a `filing` one —
  // decided, but not finished, and the operator is the only one who would notice
  // an agent that died before creating the ticket — then the resolved tail as a
  // record of what was already looked at.
  const open = findings.filter((f) => f.status === 'open');
  const filing = findings.filter((f) => f.status === 'filing');
  const resolved = findings.filter((f) => f.status !== 'open' && f.status !== 'filing').slice(0, 5);
  const card = (f: Finding) => (
    <FindingCard
      key={f.id}
      finding={f}
      now={now}
      refUrls={refUrls}
      canFileTickets={canFileTickets}
      onPromote={onPromote}
      onFile={onFile}
      onDismiss={onDismiss}
    />
  );
  return (
    <div className="findings">
      {open.map(card)}
      {filing.map(card)}
      {resolved.map(card)}
    </div>
  );
}

function FindingCard({
  finding,
  now,
  refUrls,
  canFileTickets,
  onPromote,
  onFile,
  onDismiss,
}: {
  finding: Finding;
  now: number;
  refUrls: Record<string, string>;
  canFileTickets: boolean;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onFile: (id: string) => Promise<unknown> | unknown;
  onDismiss: (id: string) => Promise<unknown> | unknown;
}) {
  const isOpen = finding.status === 'open';
  // Decided but unfinished: an agent is filing it. Drawn like an open card rather
  // than a resolved one, because the operator is the only one who would notice a
  // filing agent that died before it created anything.
  const isFiling = finding.status === 'filing';
  return (
    <div className={`finding-card${isOpen || isFiling ? '' : ' resolved'}`}>
      <div className="finding-head">
        <span className="chip small warn" title={KIND_HELP[finding.kind]}>
          {finding.kind.replace(/_/g, ' ')}
        </span>
        {finding.ref && <span className="chip small mono">{refLink(finding.ref, refUrls)}</span>}
        {!isOpen && (
          <span className="chip small" title={isFiling ? 'An agent is creating the ticket' : undefined}>
            {isFiling ? 'filing…' : finding.status}
          </span>
        )}
        {/* The ticket it became — the whole point of filing, so it is on the head
            line beside the item it is about rather than buried in the footer. */}
        {finding.ticketRef && <span className="chip small mono">{refLink(finding.ticketRef, refUrls)}</span>}
        <span className="muted finding-time">{relTime(finding.createdAt, now)}</span>
      </div>
      <div className="finding-summary">{finding.summary}</div>
      <div className="finding-foot">
        {/* Provenance, always: a finding is one agent's reading of something it saw
            while doing something else, and "who, while working on what" is most of
            how an operator judges it. */}
        <span className="muted">
          found while working {finding.originRef ? refLink(finding.originRef, refUrls) : 'an untracked task'}
        </span>
        {isOpen && (
          <span className="finding-actions">
            <AsyncButton
              className="ghost"
              onClick={() => onPromote(finding.id)}
              title="Queue this as a job — an agent works it now"
            >
              Queue job
            </AsyncButton>
            {canFileTickets && (
              <AsyncButton
                className="ghost"
                onClick={() => onFile(finding.id)}
                title="File it in the tracker so it can be picked up later"
              >
                File ticket
              </AsyncButton>
            )}
            <AsyncButton className="ghost" onClick={() => onDismiss(finding.id)} title="Read it; nothing to do">
              Dismiss
            </AsyncButton>
          </span>
        )}
      </div>
    </div>
  );
}
