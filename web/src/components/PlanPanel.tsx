import type { Plan, PlanPart, QueueItem } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { refLink, relTime } from './util.js';

/**
 * The multi-PR plan graph, per issue — the first time it is visible outside the
 * database. Until now `/api/state` fed plans into the per-issue pickup chip and
 * nothing else, so "2/5 parts merged" was all a human could see: which five, what
 * each was stacked on, and which one the dispatcher would start next were all
 * facts you had to open SQLite to learn.
 *
 * Each part carries its position in the dispatcher's own "Up next" projection
 * (joined by origin, so the two can't disagree), including the cut line — and
 * `capped`, the state a part reaches when its *plan* is at
 * `maxConcurrentPartsPerIssue` rather than the fleet being full. A capped part used
 * to be skipped silently, which is why it now has a name.
 */
export function PlanPanel({
  plans,
  parts,
  upcoming,
  now,
  refUrls,
  onReplan,
}: {
  plans: Plan[];
  parts: PlanPart[];
  /** The last pulse's ranked pickup plan, joined per part by origin. */
  upcoming: QueueItem[];
  now: number;
  refUrls: Record<string, string>;
  onReplan: (planId: string) => Promise<unknown> | unknown;
}) {
  if (plans.length === 0) {
    return <p className="empty">No plans — the planning funnel is off, or no issue has been planned yet.</p>;
  }
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  return (
    <div className="plans">
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          parts={parts.filter((p) => p.planId === plan.id).sort((a, b) => a.seq - b.seq)}
          queued={queued}
          now={now}
          refUrls={refUrls}
          onReplan={onReplan}
        />
      ))}
    </div>
  );
}

function PlanCard({
  plan,
  parts,
  queued,
  now,
  refUrls,
  onReplan,
}: {
  plan: Plan;
  parts: PlanPart[];
  queued: Map<string, QueueItem>;
  now: number;
  refUrls: Record<string, string>;
  onReplan: (planId: string) => Promise<unknown> | unknown;
}) {
  const issueNumber = issueOf(plan.originRef);
  const live = parts.filter((p) => p.status !== 'retired');
  const merged = live.filter((p) => p.status === 'merged').length;
  // The cut sits before the first part the dispatcher ranked but did not start —
  // the same rule `UpNext` draws. `capped` parts sit below it too, but they are
  // held by the plan's own limit rather than by a full fleet, so they say so.
  const cutAt = parts.findIndex((p) => {
    const q = queued.get(originOf(issueNumber, p.slug));
    return q !== undefined && q.status !== 'dispatching';
  });
  return (
    <div className="plan-card">
      <div className="plan-head">
        {issueNumber !== null && refLink(`#${issueNumber}`, refUrls)} <span className="plan-title">{plan.title}</span>
        <span className={`chip small${plan.status === 'complete' ? ' ok' : ''}`}>{plan.status}</span>
        {live.length > 0 && (
          <span className="chip small" title="Parts merged out of the parts this plan still declares">
            {merged}/{live.length} merged
          </span>
        )}
        <AsyncButton
          className="ghost world-toggle"
          onClick={() => onReplan(plan.id)}
          title={
            'Dispatch a planning agent primed with this plan and its part states. Nothing is torn down: ' +
            'agents keep running and open PRs stay open, and a part the amended plan drops is retired only ' +
            'if nothing was started for it.'
          }
        >
          replan
        </AsyncButton>
      </div>
      {plan.reason && <div className="plan-reason">{plan.reason}</div>}
      {parts.length === 0 && (
        <div className="plan-reason">
          {plan.status === 'single'
            ? 'One pull request — this issue goes through ordinary pickup.'
            : 'No parts declared yet.'}
        </div>
      )}
      {parts.map((part, idx) => (
        <div key={part.id}>
          {idx === cutAt && (
            <div className="upnext-cut" title="Everything below is ranked but not started this cycle">
              <span>not started this cycle</span>
            </div>
          )}
          <PartRow
            part={part}
            queue={queued.get(originOf(issueNumber, part.slug))}
            issueNumber={issueNumber}
            refUrls={refUrls}
          />
        </div>
      ))}
      <div className="plan-foot">updated {relTime(plan.updatedAt, now)}</div>
    </div>
  );
}

function PartRow({
  part,
  queue,
  issueNumber,
  refUrls,
}: {
  part: PlanPart;
  queue: QueueItem | undefined;
  issueNumber: number | null;
  refUrls: Record<string, string>;
}) {
  const dep = part.dependsOn[0];
  return (
    <div className={`plan-part ${part.status}`} title={part.scope}>
      <span className="plan-mark">{MARK[part.status] ?? '·'}</span>
      <span className="plan-part-title">{part.title}</span>
      <span className="chip small">{part.status.replace('_', ' ')}</span>
      {part.prNumber !== null && <span className="chip small">{refLink(`#${part.prNumber}`, refUrls)}</span>}
      {part.prNumber === null && part.branch !== null && (
        <span className="chip small mono">{refLink(part.branch, refUrls)}</span>
      )}
      {dep !== undefined && (
        <span className="chip small" title={`Stacks on the "${dep}" part — its branch is this one's base`}>
          on {dep}
        </span>
      )}
      {queue && (
        <span
          className={`chip small${queue.status === 'dispatching' ? ' ok' : queue.status === 'capped' ? ' warn' : ''}`}
          title={queue.reason}
        >
          {queue.status === 'dispatching' ? '▶ now' : queue.status}
        </span>
      )}
      {issueNumber !== null && <span className="plan-slug">{part.slug}</span>}
    </div>
  );
}

/** Where a part sits, at a glance — the same vocabulary the tracker status comment uses. */
const MARK: Record<string, string> = {
  merged: '✓',
  in_review: '◐',
  dispatched: '▸',
  blocked: '!',
  retired: '–',
};

/** The issue number a plan hangs off (`issue:12` → 12), or null for a shape we don't recognise. */
function issueOf(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/** A part's dispatch origin — the key the "Up next" queue is joined on. */
function originOf(issueNumber: number | null, slug: string): string {
  return issueNumber === null ? '' : `issue:${issueNumber}:part:${slug}`;
}
