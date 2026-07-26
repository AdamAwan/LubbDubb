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
 * The two buttons are the *only* way a finding becomes work. Nothing in the
 * dispatcher reads findings, deliberately: an agent that could queue jobs could
 * put agents on the fleet, so promotion is the operator's click. "Queue job" turns
 * one into an ordinary queued job (dispatched by rule 0 like any other); "Dismiss"
 * records that it was read and needs nothing.
 */
export function FindingsPanel({
  findings,
  now,
  refUrls,
  onPromote,
  onDismiss,
}: {
  findings: Finding[];
  now: number;
  refUrls: Record<string, string>;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onDismiss: (id: string) => Promise<unknown> | unknown;
}) {
  if (findings.length === 0) {
    return <p className="empty">Nothing reported — agents have found nothing outside their own tasks.</p>;
  }
  // Open first (they're the ones that want a decision), then the resolved tail as
  // a record of what was already looked at.
  const open = findings.filter((f) => f.status === 'open');
  const resolved = findings.filter((f) => f.status !== 'open').slice(0, 5);
  return (
    <div className="findings">
      {open.map((f) => (
        <FindingCard key={f.id} finding={f} now={now} refUrls={refUrls} onPromote={onPromote} onDismiss={onDismiss} />
      ))}
      {resolved.map((f) => (
        <FindingCard key={f.id} finding={f} now={now} refUrls={refUrls} onPromote={onPromote} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function FindingCard({
  finding,
  now,
  refUrls,
  onPromote,
  onDismiss,
}: {
  finding: Finding;
  now: number;
  refUrls: Record<string, string>;
  onPromote: (id: string) => Promise<unknown> | unknown;
  onDismiss: (id: string) => Promise<unknown> | unknown;
}) {
  const isOpen = finding.status === 'open';
  return (
    <div className={`finding-card${isOpen ? '' : ' resolved'}`}>
      <div className="finding-head">
        <span className="chip small warn" title={KIND_HELP[finding.kind]}>
          {finding.kind.replace(/_/g, ' ')}
        </span>
        {finding.ref && <span className="chip small mono">{refLink(finding.ref, refUrls)}</span>}
        {!isOpen && <span className="chip small">{finding.status}</span>}
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
              title="Queue this as a job — the only way a finding becomes work"
            >
              Queue job
            </AsyncButton>
            <AsyncButton className="ghost" onClick={() => onDismiss(finding.id)} title="Read it; nothing to do">
              Dismiss
            </AsyncButton>
          </span>
        )}
      </div>
    </div>
  );
}
