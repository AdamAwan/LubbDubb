import { useState } from 'react';
import type { Agent, Plan, PlanPart, Proposal, QueueItem } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { partOriginOf, planIssueOf, refLink, relTime } from './util.js';

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
 *
 * The Plan tab is the shape of the work, and only then the caveats. `reason` is
 * the one paragraph that says what is going to happen, so it leads; the parts
 * follow; **Risks** and **Deliberately out of scope** are folded shut behind a
 * one-line preview. All three were flat blocks of a planner's prose, at their
 * natural length, above the Approve button — three walls where the answer to
 * "what are we doing" is one of them. Folded is not hidden: the preview line is
 * there so the fold is a decision you make, not one made for you.
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
  onAbandon,
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
  onAbandon: (planId: string) => Promise<unknown> | unknown;
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
  // Both terminals — a part can finish as a write-up or a determination, and
  // counting only merges would show a finished plan as still in flight.
  const settled = live.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
  // Mirrors `partHasWork` on the server, which is what the abandon route refuses
  // on — the same relationship `partProgress` has to `partSettled`, and gating the
  // control here is the rule the Discuss button already follows: a control must
  // not offer what the route refuses.
  const started = live.some((p) => ['dispatched', 'in_review', 'merged', 'concluded'].includes(p.status));
  const issueNumber = planIssueOf(plan.originRef);
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  // A verdict is only on offer while the plan is still the thing that was
  // proposed; during a discussion there is nothing to approve, because the
  // amended plan comes back as a fresh proposal.
  const decidable = proposal?.status === 'pending' && !plan.discussing ? proposal : null;
  // `approach` is the summary once a planner writes one; `reason` stands in for it
  // on every plan stored before the field existed, which is why the fallback is
  // here rather than in the store.
  const headline = plan.approach ?? plan.reason;
  // And once `approach` carries the summary, `reason` is demoted to what it
  // actually answers — a caption on the split, next to the split.
  const shapeNote = plan.approach ? plan.reason : null;
  const cutAt = live.findIndex((p) => {
    const q = queued.get(partOriginOf(issueNumber, p.slug));
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
              {settled}/{live.length} done
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
            Plan{' '}
            <span className="count">
              {/* "0 parts" is the single-PR arm read as an empty plan. It is not
                  empty; it is the shape where the whole issue is one branch —
                  and only a plan still being written has none for the other
                  reason, which is the same split the body draws. */}
              {live.length > 0
                ? `· ${live.length} part${live.length === 1 ? '' : 's'}`
                : plan.status === 'planning'
                  ? '· being written'
                  : '· one PR'}
            </span>
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
            {plan.diagnosis && (
              <div className="pm-why pm-prose">
                <span className="pm-section-label">What&rsquo;s wrong</span>
                {renderMarkdown(plan.diagnosis, refUrls)}
              </div>
            )}
            {headline && (
              <div className="pm-why pm-prose">
                {/* On a plan that predates both fields this is `reason`, under the
                    label `reason` used to carry. The fallback is the whole reason
                    the fields are separate rather than one retargeted `reason`:
                    stored plans keep meaning what they meant when they were
                    written, and read back under a heading that is true of them. */}
                <span className="pm-section-label">
                  {plan.approach ? 'What we’ll do' : live.length > 0 ? 'Why the planner split it' : 'The approach'}
                </span>
                {renderMarkdown(headline, refUrls)}
              </div>
            )}
            {shapeNote && plan.status !== 'planning' && (
              <div className="pm-shape">
                {live.length > 0 ? 'Split this way because: ' : 'One pull request because: '}
                {shapeNote}
              </div>
            )}
            {live.length === 0 ? (
              <p className="empty">
                {/* No live parts *is* the single-PR arm — the shape is the rows,
                    not the status. Only a plan still being written has none for
                    the other reason. */}
                {plan.status === 'planning'
                  ? 'No parts declared yet.'
                  : 'One pull request — this issue goes through ordinary pickup.'}
              </p>
            ) : (
              <div>
                <span className="pm-section-label">
                  {live.length} part{live.length === 1 ? '' : 's'}, in dispatch order
                </span>
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
                      queue={queued.get(partOriginOf(issueNumber, part.slug))}
                      refUrls={refUrls}
                    />
                  </div>
                ))}
              </div>
            )}
            {(plan.risks || plan.outOfScope) && (
              <div className="pm-flags">
                {plan.risks && <Caveat kind="risk" label="Risks" body={plan.risks} refUrls={refUrls} />}
                {plan.outOfScope && (
                  <Caveat kind="oos" label="Deliberately out of scope" body={plan.outOfScope} refUrls={refUrls} />
                )}
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
              {/* The route 409s outside `awaiting_approval` (discussing a `single` or
                  `active` plan manufactures or reopens an approval gate it never had),
                  so the button must not offer what the route refuses. */}
              {plan.status === 'awaiting_approval' && (
                <AsyncButton
                  className="ghost"
                  title="Talk it through with an agent, which can amend the plan — nothing is scheduled while you do"
                  onClick={() => onDiscuss(plan.id)}
                >
                  Discuss…
                </AsyncButton>
              )}
              <AsyncButton
                className="ghost"
                title="Ask the planner again from the plan's current state. Nothing is torn down."
                onClick={() => onReplan(plan.id)}
              >
                Replan
              </AsyncButton>
              {/* The way out of a plan approved onto a branch git will not let its
                  parts sit beneath: once released, Reject is gone (it settles an
                  `awaiting_approval` plan) and a replan fails back to `parts`, so
                  without this the only exit is the database. */}
              {plan.status === 'active' && live.length > 0 && !started && (
                <AsyncButton
                  className="ghost"
                  title="Retire the parts and work this issue as one pull request. Offered only while no part has started."
                  onClick={() => onAbandon(plan.id)}
                >
                  Abandon decomposition
                </AsyncButton>
              )}
            </>
          )}
        </div>
        <div className="muted small">updated {relTime(plan.updatedAt, now)}</div>
      </div>
    </div>
  );
}

/**
 * One folded caveat — the planner's prose about what could go wrong, or what it
 * left alone. Shut by default with its opening words on the summary line, because
 * either one runs to several hundred words at the length a planner naturally
 * writes them, and both sat open above the Approve button.
 */
function Caveat({
  kind,
  label,
  body,
  refUrls,
}: {
  kind: 'risk' | 'oos';
  label: string;
  body: string;
  refUrls: Record<string, string>;
}) {
  return (
    <details className={`pm-flag ${kind}`}>
      <summary className="pm-flag-head">
        <span className="pm-section-label">{label}</span>
        <span className="pm-flag-teaser">{teaser(body)}</span>
      </summary>
      <div className="pm-prose">{renderMarkdown(body, refUrls)}</div>
    </details>
  );
}

/**
 * The first line's worth of a markdown block as plain text. The markers are
 * stripped rather than rendered: a teaser is one line of a flex row, and a
 * `**bold**` lead-in — which is how a planner opens nearly every one of these —
 * would otherwise spend that line on the label it was going to give the first
 * point anyway.
 */
function teaser(body: string): string {
  const flat = body
    // List markers first, and per line: a block that opens as a bullet would
    // otherwise lead with a stray dash, and the `*` form is indistinguishable
    // from emphasis once the markers are gone.
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 110 ? `${flat.slice(0, 110).trimEnd()}…` : flat;
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
          {/* This is the surface `planning.requireApproval` exists for: seeing that
              step 3 is "write it up" rather than "build it" is what an operator is
              approving. Shown only when the kind is not code, which is the default. */}
          {kindOf(part) && (
            <span
              className="chip small"
              title={part.status === 'concluded' ? 'What it produced' : 'What it will produce'}
            >
              {kindOf(part)}
            </span>
          )}
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
        {/* A concluded part left a record rather than a pull request, so this is the
            only place its outcome is readable at all. */}
        {part.status === 'concluded' && part.outcomeSummary && (
          <div className="pm-field">
            <b>
              {part.outcomeKind ?? 'concluded'}
              {part.expectedKind && part.expectedKind !== part.outcomeKind ? ` (planned as ${part.expectedKind})` : ''}
            </b>
            {part.outcomeSummary}
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
/**
 * What a part produced, or is expected to produce — null when that is code, which
 * is every ordinary part and would be noise on each row.
 */
function kindOf(part: PlanPart): string | null {
  const kind = part.status === 'concluded' ? (part.outcomeKind ?? 'concluded') : (part.expectedKind ?? null);
  return kind && kind !== 'code' ? kind : null;
}
