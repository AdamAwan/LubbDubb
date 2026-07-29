import type { Plan, PlanPart, QueueItem } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { refChip, refLink, relTime } from './util.js';

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
 * `maxConcurrentPartsPerIssue` rather than the fleet being full, and `unapproved`,
 * the state every part of a plan sits in while its decomposition is a proposal a
 * human hasn't accepted. Both used to be invisible — a silently skipped part looks
 * exactly like an idle fleet — which is why each now has a name.
 */
export function PlanPanel({
  plans,
  parts,
  upcoming,
  now,
  refUrls,
  onReplan,
  onViewPlan,
}: {
  plans: Plan[];
  parts: PlanPart[];
  /** The last pulse's ranked pickup plan, joined per part by origin. */
  upcoming: QueueItem[];
  now: number;
  refUrls: Record<string, string>;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  /** Open the full plan modal — the parts, their scopes, and the planner's write-up. */
  onViewPlan: (planId: string) => void;
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
          onViewPlan={onViewPlan}
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
  onViewPlan,
}: {
  plan: Plan;
  parts: PlanPart[];
  queued: Map<string, QueueItem>;
  now: number;
  refUrls: Record<string, string>;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onViewPlan: (planId: string) => void;
}) {
  const issueNumber = issueOf(plan.originRef);
  const live = parts.filter((p) => p.status !== 'retired');
  // Every terminal, not just merges — a part can finish as a write-up or as the
  // determination that nothing needed building, and counting only merges would
  // show a finished plan as still in flight.
  const settled = live.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
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
        <span
          className={`chip small${plan.status === 'complete' ? ' ok' : plan.status === 'awaiting_approval' ? ' warn' : ''}`}
        >
          {plan.status.replace(/_/g, ' ')}
        </span>
        {live.length > 0 && (
          <span className="chip small" title="Parts finished out of the parts this plan still declares">
            {settled}/{live.length} done
          </span>
        )}
        {/* The one thing this plan has said to the world without anyone
            authorising it: the status comment the reconciler keeps on the issue,
            edited in place and written only when there is news (#171). It is
            deliberately not auto-send gated, which rests on an operator being
            able to read it — so it is linked here rather than left to whoever
            thinks to open the tracker. Absent, or unresolvable, draws nothing. */}
        {refChip(plan.statusCommentRef, 'status comment ↗', refUrls, {
          title: "The plan's one living status comment on the issue — the harness's own progress notice",
        })}
        <button
          className="btn ghost world-toggle"
          onClick={() => onViewPlan(plan.id)}
          title="The whole plan: every part's scope, why it is its own PR, and the planner's write-up"
        >
          view
        </button>
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
      {plan.status === 'awaiting_approval' && (
        <div className="plan-reason">
          Nothing below is scheduled until you approve this decomposition — the proposal is in “Needs you”. Rejecting it
          works the issue as a single pull request instead.
        </div>
      )}
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
      {/* What it produced, or — before it finishes — what the planner expected it to.
          Only when that is not code: every other part is a PR, and saying so on each
          row would bury the two that are not. */}
      {kindChip(part)}
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
          className={`chip small${
            queue.status === 'dispatching'
              ? ' ok'
              : queue.status === 'capped' || queue.status === 'unapproved'
                ? ' warn'
                : ''
          }`}
          title={queue.reason}
        >
          {queue.status === 'dispatching' ? '▶ now' : queue.status}
        </span>
      )}
      {issueNumber !== null && <span className="plan-slug">{part.slug}</span>}
    </div>
  );
}

/**
 * What a part produced (once concluded) or is expected to produce, when that is
 * anything other than code. A mismatch between the two is *shown*, never treated
 * as an error: the planner expecting code and the agent finding a duplicate is
 * exactly what an operator wants to see.
 */
function kindChip(part: PlanPart) {
  const actual = part.status === 'concluded' ? (part.outcomeKind ?? 'concluded') : null;
  const kind = actual ?? (part.expectedKind && part.expectedKind !== 'code' ? part.expectedKind : null);
  if (!kind || kind === 'code') return null;
  const planned =
    actual && part.expectedKind && part.expectedKind !== actual ? ` · planned as ${part.expectedKind}` : '';
  return (
    <span className="chip small" title={`${actual ? 'Produced' : 'Planned to produce'} a ${kind}${planned}`}>
      {kind}
      {planned}
    </span>
  );
}

/** Where a part sits, at a glance — the same vocabulary the tracker status comment uses. */
const MARK: Record<string, string> = {
  merged: '✓',
  concluded: '✓',
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
