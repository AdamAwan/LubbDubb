import { useState } from 'react';
import type { Agent, Plan, PlanPart, Proposal, QueueItem } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { refLink, relTime } from './util.js';

/**
 * The whole plan, on demand — the record of what was agreed, not just the
 * question that was asked.
 *
 * Until now a decomposition was legible only while it was a pending proposal: the
 * approval card rendered a template string and vanished on the click, and the
 * Plans panel drew rows whose `scope` was a tooltip. Which five parts, why each
 * was its own PR, what the planner thought could go wrong and what it left out
 * were all facts you opened SQLite to learn.
 *
 * Two tabs rather than one scroll, because the decision view has to stay short
 * enough to hold in your head while you decide. The cost is that the write-up is
 * one click away; the alternative cost — a wall of prose above the buttons — is
 * worse, because it is paid on every approval rather than on the ones where you
 * want the detail.
 */
export function PlanModal({
  plan,
  parts,
  upcoming,
  proposal,
  agent,
  now,
  refUrls,
  onClose,
  onReplan,
  onDiscuss,
  onEndDiscussion,
  onDecide,
  onOpenAgent,
  onRespond,
}: {
  plan: Plan;
  parts: PlanPart[];
  /** The last pulse's ranked plan, joined per part by origin — the dispatch cut. */
  upcoming: QueueItem[];
  /** The pending approval this plan is waiting on, when it is waiting on one. */
  proposal?: Proposal;
  /** The discussion agent, when one is live on this plan's planner origin. */
  agent?: Agent;
  now: number;
  refUrls: Record<string, string>;
  onClose: () => void;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onDiscuss: (planId: string) => Promise<unknown> | unknown;
  onEndDiscussion: (planId: string) => Promise<unknown> | unknown;
  onDecide: (id: string, verdict: 'accept' | 'reject', note?: string) => Promise<unknown> | unknown;
  onOpenAgent: (agentId: string) => void;
  onRespond: (agentId: string, text: string) => Promise<unknown> | unknown;
}) {
  const [tab, setTab] = useState<'plan' | 'writeup'>('plan');
  const [note, setNote] = useState('');
  const [say, setSay] = useState('');
  const send = useAsyncAction();

  const live = parts.filter((p) => p.status !== 'retired');
  const merged = live.filter((p) => p.status === 'merged').length;
  const issueNumber = issueOf(plan.originRef);
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  // A verdict is only on offer while the plan is still the thing that was
  // proposed; during a discussion there is nothing to approve, because the
  // amended plan comes back as a fresh proposal.
  const decidable = proposal?.status === 'pending' && !plan.discussing ? proposal : null;
  const cutAt = live.findIndex((p) => {
    const q = queued.get(originOf(issueNumber, p.slug));
    return q !== undefined && q.status !== 'dispatching';
  });

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          {issueNumber !== null && refLink(`#${issueNumber}`, refUrls)}
          <span className="pm-title">{plan.title}</span>
          <span className={`chip small${plan.status === 'complete' ? ' ok' : decidable ? ' warn' : ''}`}>
            {plan.discussing ? 'discussing' : plan.status.replace(/_/g, ' ')}
          </span>
          {live.length > 0 && (
            <span className="chip small">
              {merged}/{live.length} merged
            </span>
          )}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>

        {plan.discussing && agent && (
          <div className="pm-discussion">
            <div className="pm-head">
              <span className="pm-section-label">Discussion</span>
              <span className="chip small ok">{agent.status}</span>
              <button className="btn ghost small pm-close" onClick={() => onOpenAgent(agent.id)}>
                Open full transcript →
              </button>
            </div>
            {agent.note && <div className="pm-note-line">{agent.note}</div>}
            <form
              className="pm-say"
              onSubmit={(e) => {
                e.preventDefault();
                const value = say.trim();
                if (!value) return;
                void send.run(async () => {
                  await onRespond(agent.id, value);
                  setSay('');
                });
              }}
            >
              <input placeholder="Say something to the planner…" value={say} onChange={(e) => setSay(e.target.value)} />
              <SubmitButton phase={send.phase} className="primary">
                Send
              </SubmitButton>
            </form>
          </div>
        )}

        <div className="pm-tabs">
          <button className={`pm-tab${tab === 'plan' ? ' on' : ''}`} onClick={() => setTab('plan')}>
            Plan <span className="count">· {live.length} parts</span>
          </button>
          <button className={`pm-tab${tab === 'writeup' ? ' on' : ''}`} onClick={() => setTab('writeup')}>
            Full write-up
          </button>
        </div>

        {tab === 'writeup' ? (
          plan.document ? (
            <div className="pm-doc">{renderMarkdown(plan.document)}</div>
          ) : (
            // Said rather than hidden: an absent tab reads as "the planner had
            // nothing to add", which is indistinguishable from "the planner
            // ignored the instruction" — and only one of those is your problem.
            <p className="empty">
              This planner wrote no write-up. Replan to ask again, or discuss it if you want the reasoning.
            </p>
          )
        ) : (
          <>
            {plan.reason && (
              <div className="pm-why">
                <span className="pm-section-label">Why the planner split it</span>
                {plan.reason}
              </div>
            )}
            {(plan.risks || plan.outOfScope) && (
              <div className="pm-flags">
                {plan.risks && (
                  <div className="pm-flag risk">
                    <span className="pm-section-label">Risks</span>
                    {plan.risks}
                  </div>
                )}
                {plan.outOfScope && (
                  <div className="pm-flag oos">
                    <span className="pm-section-label">Deliberately out of scope</span>
                    {plan.outOfScope}
                  </div>
                )}
              </div>
            )}
            {live.length === 0 ? (
              <p className="empty">
                {plan.status === 'single'
                  ? 'One pull request — this issue goes through ordinary pickup.'
                  : 'No parts declared yet.'}
              </p>
            ) : (
              <div>
                <span className="pm-section-label">{live.length} parts, in dispatch order</span>
                {live.map((part, idx) => (
                  <div key={part.id}>
                    {idx === cutAt && (
                      <div className="pm-cut">
                        <span>
                          {decidable ? 'nothing below is scheduled until you approve' : 'not started this cycle'}
                        </span>
                      </div>
                    )}
                    <PartBlock
                      part={part}
                      seq={idx + 1}
                      queue={queued.get(originOf(issueNumber, part.slug))}
                      refUrls={refUrls}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="pm-foot">
          {plan.discussing ? (
            <>
              <span className="muted small">
                While a discussion is running nothing is scheduled, and there is no approval to give — the amended plan
                comes back as a fresh proposal.
              </span>
              <span className="spacer" />
              <AsyncButton
                className="ghost"
                title="Stop the conversation and put the plan back up for approval unchanged"
                onClick={() => onEndDiscussion(plan.id)}
              >
                End discussion
              </AsyncButton>
            </>
          ) : (
            <>
              {decidable && (
                <>
                  <input
                    className="pm-note"
                    placeholder="Why (optional) — recorded either way"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <AsyncButton
                    className="primary"
                    title="Release the plan — each part gets its own agent, branch and pull request"
                    onClick={() => onDecide(decidable.id, 'accept', note.trim() || undefined)}
                  >
                    Approve plan
                  </AsyncButton>
                  <AsyncButton
                    className="ghost"
                    title="Retires the parts nothing has started for and works the issue as a single pull request"
                    onClick={() => onDecide(decidable.id, 'reject', note.trim() || undefined)}
                  >
                    Reject
                  </AsyncButton>
                </>
              )}
              <span className="spacer" />
              <AsyncButton
                className="ghost"
                title="Talk it through with an agent, which can amend the plan — nothing is scheduled while you do"
                onClick={() => onDiscuss(plan.id)}
              >
                Discuss…
              </AsyncButton>
              <AsyncButton
                className="ghost"
                title="Ask the planner again from the plan's current state. Nothing is torn down."
                onClick={() => onReplan(plan.id)}
              >
                Replan
              </AsyncButton>
            </>
          )}
        </div>
        <div className="muted small">updated {relTime(plan.updatedAt, now)}</div>
      </div>
    </div>
  );
}

function PartBlock({
  part,
  seq,
  queue,
  refUrls,
}: {
  part: PlanPart;
  seq: number;
  queue: QueueItem | undefined;
  refUrls: Record<string, string>;
}) {
  const dep = part.dependsOn[0];
  return (
    <div className="pm-part">
      <span className="pm-seq">{seq}</span>
      <div>
        <div className="pm-part-head">
          <span className="pm-part-title">{part.title}</span>
          <span className="chip small mono">{part.slug}</span>
          <span className="chip small">{part.status.replace('_', ' ')}</span>
          {part.prNumber !== null && <span className="chip small">{refLink(`#${part.prNumber}`, refUrls)}</span>}
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
        </div>
        <div className="pm-scope">{part.scope}</div>
        {part.rationale && (
          <div className="pm-field">
            <b>why its own PR</b>
            {part.rationale}
          </div>
        )}
        {part.acceptance && (
          <div className="pm-field">
            <b>done when</b>
            {part.acceptance}
          </div>
        )}
        {/*
          Spelled out rather than left as an `on <slug>` chip: the stack edge is
          what decides which branch this part is cut from, and getting it wrong is
          the one planning mistake that is expensive to undo.
        */}
        <div className="pm-stack">
          {dep === undefined
            ? 'stacks on nothing — starts from the default branch'
            : `stacks on "${dep}" — based on that part's branch`}
        </div>
      </div>
    </div>
  );
}

/** The issue number a plan hangs off (`issue:12` → 12), or null for a shape we don't recognise. */
function issueOf(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/** A part's dispatch origin — the key the "Up next" queue is joined on. */
function originOf(issueNumber: number | null, slug: string): string {
  return issueNumber === null ? '' : `issue:${issueNumber}:part:${slug}`;
}
