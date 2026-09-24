import type { PendingPlanAmendment, PlanDiff, PlanHistory } from '../types.js';
import { relTime } from './util.js';
import { HeadRow } from './panel.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/17-cockpit.md

export function HistoryView({ history, now }: { history: PlanHistory | null; now: number }) {
  if (history === null) return <p className="empty">The history for this plan could not be read.</p>;
  const { diff, pending, revisions } = history;
  const latest = revisions[revisions.length - 1];
  return (
    <>
      {/* Above the history, because it is the only part of this view that is a
          question rather than a record: a plan still scheduling, with a change
          somebody is waiting on an answer to. */}
      {pending !== null && <PendingAmendment pending={pending} now={now} />}
      <div className="pm-revs">
        {revisions.map((rev) => (
          <Tag tone={rev === latest ? 'green' : undefined} key={rev.id} title={rev.narrative.reason ?? ''}>
            v{rev.seq} · {rev.parts.length} part{rev.parts.length === 1 ? '' : 's'} · {relTime(rev.at, now)}
          </Tag>
        ))}
      </div>
      {diff === null ? (
        <p className="empty">One plan, never amended — there is nothing to compare it to.</p>
      ) : (
        <DiffBody diff={diff} />
      )}
    </>
  );
}

function PendingAmendment({ pending, now }: { pending: PendingPlanAmendment; now: number }) {
  return (
    <section className="pm-pending">
      <HeadRow align="baseline" className="pm-pending-head">
        <span className="pm-section-label">Waiting on you</span>
        <Tag tone="amber">amendment</Tag>
        <span className="muted small">
          proposed by {pending.author === 'operator' ? 'you' : 'an agent'} · {relTime(pending.createdAt, now)}
        </span>
      </HeadRow>
      <p className="pm-pending-note">{pending.note}</p>
      {pending.diff === null ? (
        <p className="empty">There is no earlier version to compare this against.</p>
      ) : (
        <DiffBody diff={pending.diff} />
      )}
      {pending.warnings.length > 0 && (
        <ul className="pm-pending-warnings">
          {pending.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {/* Said rather than left to be inferred from the plan still drawing its
          parts: the one thing an operator must not read off a pending amendment
          is that the work is on hold while they decide. */}
      <p className="muted small">
        The plan is still running: every part that was scheduling still is, and nothing changes until you accept this on
        its card. Decline it and the plan carries on exactly as it is.
      </p>
    </section>
  );
}

const DIFF_TONE: Record<PlanDiff['parts'][number]['kind'], TagTone | undefined> = {
  added: 'green',
  dropped: 'red',
  changed: 'blue',
  unchanged: undefined,
};

function DiffBody({ diff }: { diff: PlanDiff }) {
  const moved = diff.parts.filter((p) => p.kind !== 'unchanged');
  const unchanged = diff.parts.length - moved.length;
  return (
    <>
      <div className="pm-diff-head">
        <span className="pm-section-label">
          v{diff.seq} against v{diff.againstSeq}
        </span>
        {moved.length === 0 && <Tag>no part changed</Tag>}
        {unchanged > 0 && <Tag>{unchanged} unchanged</Tag>}
      </div>
      {moved.map((change) => (
        <div className="pm-diff-row" key={change.slug}>
          <Tag tone={DIFF_TONE[change.kind]} fill={DIFF_TONE[change.kind] !== undefined}>
            {change.kind === 'dropped' ? 'no longer' : change.kind}
          </Tag>
          <div>
            <div className="pm-part-head">
              <span className="pm-part-title">{change.title}</span>
              <Tag lower>{change.slug}</Tag>
            </div>
            {change.kind === 'dropped' && (
              <div className="pm-was">
                Not declared any more. It is retired only if nothing was started for it — a part with a branch or a pull
                request stays exactly as it was.
              </div>
            )}
            {change.fields.map((f) => (
              <div className="pm-was" key={f.field}>
                <b>{f.field}</b>
                {f.from !== null && <s>{f.from}</s>}
                {f.from !== null && f.to !== null && ' → '}
                {f.to !== null && <ins>{f.to}</ins>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {diff.narrative.length > 0 && (
        <div className="pm-diff-row">
          <Tag>prose</Tag>
          <div className="pm-was">
            {diff.narrative.map((n, i) => (
              <span key={n.field}>
                {i > 0 && ' · '}
                <b>{n.field}</b> {n.kind}
              </span>
            ))}
            <p className="muted small">
              The current text is on the Plan view — this says which fields the amendment rewrote, not how they read
              before.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
