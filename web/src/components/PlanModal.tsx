import { useEffect, useRef, useState } from 'react';
import type {
  AcceptanceCriterion,
  GoalWatch,
  IssueSpend,
  Plan,
  PlanDiff,
  PlanEvidence,
  PlanHistory,
  PendingPlanAmendment,
  PlanPartView,
  PlanningPolicy,
  Proposal,
  QueueItem,
  ValidationCheck,
} from '../types.js';
import { api } from '../api.js';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from './DesktopLink.js';
import { CaveatChecklist, heldTitle, useAcknowledgements } from './CaveatChecklist.js';
import { planCaveatsOf } from '../planCaveats.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { PlanMap } from './PlanMap.js';
import { ProfilePicker } from './ProfilePicker.js';
import { ValidationDigest } from './ValidationSection.js';
import { WatchDigest } from './WatchDigest.js';
import { partOriginOf, planIssueOf, refLink, relTime } from './util.js';
import { Modal } from './Modal.js';
import { Ref } from './refs.js';
import { HeadRow } from './panel.js';
import { buttonClass } from './button.js';

/**
 * The plan sheet — the whole plan, in one scroll, as the record of what was agreed.
 *
 * It replaced a two-tab modal, and each of the four changes answers something the
 * modal could not say:
 *
 * - **The shape is drawn** ({@link PlanMap}), because a decomposition is a graph
 *   and the modal rendered it as a list with one sentence per part. The stack edge
 *   decides which branch a part is cut from, and it is the one planning mistake
 *   that is expensive to undo.
 * - **The decision states its consequence.** The footer used to offer Approve /
 *   Reject / Discuss with no account of what approving *starts* — how many
 *   branches, how many agents at once, what begins on the click.
 * - **An amendment is read as a change.** A replan and a discussion both rewrite
 *   the plan row, so ten minutes of conversation came back as the whole
 *   decomposition again, with nothing saying which two parts moved. The History
 *   view is the server's own diff over the stored revisions.
 * - **The write-up is a section, not a tab.** A tab is a thing you have to know to
 *   click; the rail above jumps to it, and scrolling reaches it anyway.
 *
 * The reading order is answer, then work, then caveats: what's wrong and what
 * we'll do, the map, the parts, the four caveats, the write-up. `reason` is a
 * caption on the shape rather than a section, because it answers only the narrow
 * question of why *this split*.
 */
export function PlanModal({
  plan,
  parts,
  checks,
  watches,
  upcoming,
  proposal,
  spend,
  planning,
  now,
  refUrls,
  onClose,
  onReplan,
  onWatchProposal,
  onDecide,
  onBackOut,
  onCommentDraft,
  onOpenGoal,
  onAcceptance,
  onPartProfile,
  onRestartPart,
  canClosePr,
  profiles,
  defaultProfile,
  desktopFolder,
}: {
  plan: Plan;
  parts: PlanPartView[];
  /** This plan's validation checks, superseded ones included. Drawn read-only. */
  checks: ValidationCheck[];
  /**
   * This goal's post-deploy watch — what a running system would have to show once
   * the work ships. Empty where the plan declared none, and then nothing draws.
   */
  watches: GoalWatch[];
  /** The last pulse's ranked plan, joined per part by origin — the dispatch cut. */
  upcoming: QueueItem[];
  /** The pending approval this plan is waiting on, when it is waiting on one. */
  proposal?: Proposal;
  /** What this goal has cost so far. Null is "nothing was ever measured", not zero. */
  spend: IssueSpend | null;
  /** The funnel's policy — what the approval bar states about rate. */
  planning: PlanningPolicy;
  now: number;
  refUrls: Record<string, string>;
  onClose: () => void;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  /** The operator's ruling on a check `watch_declare` wrote — see {@link WatchDigest}. */
  onWatchProposal: (issueNumber: number, checkId: string, accept: boolean) => Promise<unknown> | unknown;
  /**
   * The verdict, with the caveat ids the operator ticked. Approving a plan that
   * raises caveats is refused server-side until they are named — see
   * `web/src/components/CaveatChecklist.tsx`.
   */
  onDecide: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
  ) => Promise<unknown> | unknown;
  /**
   * The two answers that are about the **ticket** rather than the plan — close it
   * with the note as its comment, or hold it by dropping the watch tag. Offered
   * here as well as on the inbox card because this is the surface where the
   * operator has actually read the plan, and reading it is what tends to produce
   * "this is not really an issue".
   */
  onBackOut: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
  /** Fetch the placeholder closing comment into the note box, to be edited. Nothing is posted by it. */
  onCommentDraft: (id: string) => Promise<string>;
  /** Open the goal this plan hangs off — where its checks are now recorded. */
  onOpenGoal: (issueRef: string) => void;
  onAcceptance: (planId: string, slug: string, criterion: string, met: boolean) => Promise<unknown> | unknown;
  /** Override which profile one part runs on, or clear it back to inheriting the goal's pin (#342). */
  onPartProfile: (planId: string, slug: string, profile: string | null) => Promise<unknown> | unknown;
  /**
   * Close a part's pull request, drop its branch and hand the part back to the
   * fleet — the way out of an amendment that rewrote work already in review.
   */
  onRestartPart: (planId: string, slug: string) => Promise<unknown> | unknown;
  /**
   * `config.canClosePr` — whether this deployment's provider can close a pull
   * request at all. False draws no restart control anywhere on the sheet, the way
   * the board draws no drag where `canSetWorkItemState` is false: a button that
   * closed nothing would take the part back to `ready` and let the reconciler put
   * it straight back into review.
   */
  canClosePr: boolean;
  /** The profiles a part may be pinned to, cheapest first, and what an unpinned one falls back to. */
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
  /** `config.desktopFolder` — the checkout Discuss opens the operator's own Claude Code on. */
  desktopFolder: string;
}) {
  const [view, setView] = useState<'plan' | 'history'>('plan');
  const [note, setNote] = useState('');
  const [pins, setPins] = useState<Record<string, Pin>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const history = usePlanHistory(plan.id, plan.updatedAt);
  const body = useRef<HTMLDivElement>(null);
  const sections = useRef<Record<string, HTMLElement | null>>({});

  const live = parts.filter((p) => p.status !== 'retired');
  // Both terminals — a part can finish as a write-up or a determination, and
  // counting only merges would show a finished plan as still in flight.
  const settled = live.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
  const liveChecks = checks.filter((c) => c.supersededReason === null);
  const settledChecks = liveChecks.filter((c) => c.state === 'passed' || c.state === 'waived').length;
  const issueNumber = planIssueOf(plan.originRef);
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  // A verdict is only on offer while the plan is still the thing that was
  // proposed. A discussion at the operator's own keyboard does not change that:
  // it settles by *amending*, and the amendment withdraws this card and puts a
  // fresh one up, so the one drawn here is always about the plan on screen.
  const decidable = proposal?.status === 'pending' ? proposal : null;
  // The same list the inbox card draws and the accept route enforces, read off the
  // proposal rather than re-derived from the plan sheet's own caveat sections: the
  // operator ticks ids, and two derivations of one list is the drift this repo has
  // fixed before. Drawn here as well because this is the surface where the plan has
  // actually been read, and it is the other button that releases it.
  const caveats = planCaveatsOf(decidable ?? undefined);
  const ack = useAcknowledgements(caveats);
  const held = ack.outstanding.length > 0;
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
  const originOf = (slug: string): string => partOriginOf(issueNumber, slug);
  // Discuss is a link, not a dispatch. It opens the operator's own Claude Code on
  // this repository with the `/lubbdubb` skill's own argument already in the box;
  // the session reads the plan through `plan_read`, argues about it with the code
  // in front of it, and ends by calling `plan_amend` — which withdraws the card
  // below and puts a fresh one up. Nothing is written here, so there is nothing to
  // undo if they close the window and change their mind.
  //
  // Null on a plan whose origin names no goal number: `plan_amend` resolves a plan
  // *by* that number, so there is no conversation to link to — and a control that
  // opened a session which could not find what it was sent for is worse than no
  // control.
  // The two Discuss controls below are the same control in two places, so the
  // sentence is written once here and handed to both. It used to be written twice
  // and said neither time what command the session would arrive with — the deep
  // link's standing rule, which `DesktopLink` now keeps rather than each site.
  // And it forks on the status, because what the session can do at the end of the
  // conversation does: a released plan is *proposed against*, and telling an
  // operator their running work is about to be rewritten would be the wrong half
  // of that.
  const discuss =
    plan.status === 'active'
      ? 'so the plan is talked through with a session that can propose a change to it — the plan keeps running while you decide, and nothing changes until you accept.'
      : 'so the plan is talked through with a session that can amend it — nothing is scheduled, and nothing changes until it does.';

  const jump = (key: string): void => {
    setView('plan');
    // Deferred a frame: on a jump from the History view the target section does
    // not exist until `view` has re-rendered, and scrolling to a missing node is
    // silently nothing at all.
    requestAnimationFrame(() => sections.current[key]?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const focusPart = (slug: string): void => {
    setFocused(slug);
    jump(`part:${slug}`);
  };

  return (
    <Modal
      face="sheet"
      title={plan.title}
      /* The goal the plan hangs off, as the way onto its page: the sheet is
         opened from several surfaces and is the one place a plan is read, so a
         number here that led nowhere was the longest way back. */
      lead={<Ref to={plan.originRef} />}
      chips={
        <>
          <span className={`chip small${plan.status === 'complete' ? ' ok' : decidable ? ' warn' : ''}`}>
            {plan.status.replace(/_/g, ' ')}
          </span>
          {live.length > 0 && (
            <span className="chip small">
              {settled}/{live.length} done
            </span>
          )}
          {/* The one comment the plan keeps on the ticket — where everyone who is
              not looking at this sheet reads the plan. */}
          {plan.statusCommentRef !== null && (
            <span className="chip small">{refLink(plan.statusCommentRef, refUrls)}</span>
          )}
        </>
      }
      onClose={onClose}
    >
      <div className="pm-rail">
        <button className="pm-jump" onClick={() => jump('verdict')}>
          Verdict
        </button>
        {live.length > 0 && (
          <button className="pm-jump" onClick={() => jump('shape')}>
            The shape
          </button>
        )}
        <button className="pm-jump" onClick={() => jump('parts')}>
          Parts <i className="k">{live.length > 0 ? live.length : 'one PR'}</i>
        </button>
        <button className="pm-jump" onClick={() => jump('validation')}>
          Validation <i className="k">{liveChecks.length > 0 ? `${settledChecks}/${liveChecks.length}` : 'none'}</i>
        </button>
        <button className="pm-jump" onClick={() => jump('caveats')}>
          Caveats
        </button>
        <button className="pm-jump" onClick={() => jump('writeup')}>
          Write-up
        </button>
        <span className="spacer" />
        {/* A view, not a jump — a different document, so it reads as a different
              control. Absent until there is a second revision to be a change from,
              or a change waiting on the operator to be asked about. */}
        {history !== null && (history.revisions.length > 1 || history.pending !== null) && (
          <button
            className={`pm-jump history${view === 'history' ? ' on' : ''}${history.pending ? ' waiting' : ''}`}
            onClick={() => setView(view === 'history' ? 'plan' : 'history')}
          >
            {/* A change waiting on the operator outranks the history it would
                  become: it is the one thing on this sheet that is asking them
                  something, and it is why the control is offered at all on a plan
                  with a single revision. */}
            {history.pending ? 'Change waiting' : history.diff === null ? 'History' : 'What changed'}{' '}
            <i className="k">v{history.revisions.length}</i>
          </button>
        )}
      </div>

      <div className="pm-body" ref={body}>
        {view === 'history' ? (
          <HistoryView history={history} now={now} />
        ) : (
          <>
            <section
              ref={(el) => {
                sections.current.verdict = el;
              }}
              className="pm-verdict"
            >
              {plan.diagnosis && (
                <div className="pm-vcell wrong">
                  <span className="pm-section-label">What&rsquo;s wrong</span>
                  <div className="pm-prose">{renderMarkdown(plan.diagnosis, refUrls)}</div>
                  {plan.evidence.length > 0 && <Evidence evidence={plan.evidence} />}
                </div>
              )}
              {headline && (
                <div className="pm-vcell do">
                  {/* On a plan that predates both fields this is `reason`, under the
                        label `reason` used to carry. The fallback is the whole reason
                        the fields are separate rather than one retargeted `reason`:
                        stored plans keep meaning what they meant when they were
                        written, and read back under a heading that is true of them. */}
                  <span className="pm-section-label">
                    {plan.approach ? 'What we’ll do' : live.length > 0 ? 'Why the planner split it' : 'The approach'}
                  </span>
                  <div className="pm-prose">{renderMarkdown(headline, refUrls)}</div>
                  {plan.verification && (
                    <div className="pm-verify">
                      <b>How we&rsquo;ll know it worked</b>
                      {renderMarkdown(plan.verification, refUrls)}
                    </div>
                  )}
                </div>
              )}
              {/* Evidence with no diagnosis to sit under still belongs on the
                    sheet: it is what the planner read, and hiding it would lose the
                    only checkable thing on a plan whose author skipped the field. */}
              {!plan.diagnosis && plan.evidence.length > 0 && (
                <div className="pm-vcell wrong">
                  <span className="pm-section-label">What the planner read</span>
                  <Evidence evidence={plan.evidence} />
                </div>
              )}
            </section>

            {live.length > 1 && (
              <section
                ref={(el) => {
                  sections.current.shape = el;
                }}
              >
                <span className="pm-section-label">The shape</span>
                {/* Normal case, under the label rather than inside it: `reason` is
                      a sentence, and a sentence set in the label's letter-spaced
                      uppercase is a sentence nobody reads. */}
                {shapeNote !== null && <div className="pm-shape">Split this way because: {shapeNote}</div>}
                <PlanMap parts={live} queued={queued} originOf={originOf} selected={focused} onSelect={focusPart} />
              </section>
            )}

            <section
              ref={(el) => {
                sections.current.parts = el;
              }}
            >
              {live.length === 0 ? (
                <p className="empty">
                  {/* Every plan declares at least one part, so the only plan with
                        none is one still being written — or one whose every part an
                        amendment retired. */}
                  {plan.status === 'planning' ? 'No parts declared yet.' : 'Every part of this plan was retired.'}
                </p>
              ) : (
                <>
                  <span className="pm-section-label">
                    {live.length} part{live.length === 1 ? '' : 's'}, in dispatch order
                    {shapeNote !== null ? ` — ${shapeNote}` : ''}
                  </span>
                  {live.map((part, idx) => (
                    <div
                      key={part.id}
                      ref={(el) => {
                        sections.current[`part:${part.slug}`] = el;
                      }}
                    >
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
                        queue={queued.get(originOf(part.slug))}
                        focused={part.slug === focused}
                        pin={pins[part.slug]}
                        pinnable={decidable !== null}
                        onPin={(pin) => setPins({ ...pins, [part.slug]: pin })}
                        onAcceptance={(criterion, met) => onAcceptance(plan.id, part.slug, criterion, met)}
                        onPartProfile={(profile) => onPartProfile(plan.id, part.slug, profile)}
                        onRestart={canClosePr ? () => onRestartPart(plan.id, part.slug) : undefined}
                        profiles={profiles}
                        defaultProfile={defaultProfile}
                      />
                    </div>
                  ))}
                </>
              )}
            </section>

            <section
              ref={(el) => {
                sections.current.validation = el;
              }}
            >
              {/* Read-only, because the sheet defines the checks and the goal
                    page runs them. A plan under review still has to show what it
                    proposes to check — that is part of judging it — but a reading
                    is recorded against the *goal*, and offering the verbs in two
                    places is two wirings of one set of refusals. */}
              <ValidationDigest
                checks={checks}
                refUrls={refUrls}
                onOpenGoal={
                  issueNumber === null
                    ? null
                    : () => {
                        onOpenGoal(`issue:${issueNumber}`);
                        onClose();
                      }
                }
              />
            </section>

            <section
              ref={(el) => {
                sections.current.watch = el;
              }}
            >
              {/* Read-only for {@link ValidationDigest}'s reason, and below it
                    deliberately: validation asks whether the goal was met, and this
                    asks whether the thing is behaving once it is there — the later
                    question, drawn later. Nothing renders where nothing was
                    declared. */}
              <WatchDigest
                watches={watches}
                refUrls={refUrls}
                // Null where the sheet cannot name the goal: the ruling is keyed
                // on the issue, and a control that could not say which goal it
                // was accepting for would be a button with no destination.
                onRule={
                  issueNumber === null ? null : (checkId, accept) => void onWatchProposal(issueNumber, checkId, accept)
                }
              />
            </section>

            <section
              ref={(el) => {
                sections.current.caveats = el;
              }}
              className="pm-flags"
            >
              {/* Four, and the order is how much they bear on the decision in front
                    of you: what else we could have done, what we are unsure of, what
                    could go wrong, what we are not doing. */}
              {plan.alternatives && (
                <Caveat kind="alt" label="Considered and rejected" body={plan.alternatives} refUrls={refUrls} />
              )}
              {plan.openQuestions && (
                <Caveat
                  kind="open"
                  label="Least sure about"
                  body={plan.openQuestions}
                  refUrls={refUrls}
                  // Opened by default while a verdict is pending: it is the field
                  // written for exactly this moment, and folded shut it is one more
                  // thing that has to be clicked before it can change a mind.
                  open={decidable !== null}
                />
              )}
              {plan.risks && <Caveat kind="risk" label="Risks" body={plan.risks} refUrls={refUrls} />}
              {plan.outOfScope && (
                <Caveat kind="oos" label="Deliberately out of scope" body={plan.outOfScope} refUrls={refUrls} />
              )}
              {!plan.alternatives && !plan.openQuestions && !plan.risks && !plan.outOfScope && (
                <p className="empty">This planner recorded no caveats — no alternatives, risks or exclusions.</p>
              )}
            </section>

            <section
              ref={(el) => {
                sections.current.writeup = el;
              }}
            >
              <span className="pm-section-label">The full write-up</span>
              {plan.document ? (
                <div className="pm-doc">{renderMarkdown(plan.document, refUrls)}</div>
              ) : (
                // Said rather than hidden: an absent section reads as "the planner
                // had nothing to add", which is indistinguishable from "the planner
                // ignored the instruction" — and only one of those is your problem.
                <p className="empty">
                  This planner wrote no write-up. Replan to ask again, or discuss it if you want the reasoning.
                </p>
              )}
            </section>
          </>
        )}
      </div>

      <div className="pm-foot">
        {decidable && (
          <Decision
            parts={live}
            planning={planning}
            spend={spend}
            queued={queued}
            originOf={originOf}
            issueNumber={issueNumber}
          />
        )}
        {decidable && <CaveatChecklist caveats={caveats} ticked={ack.ticked} onToggle={ack.toggle} refUrls={refUrls} />}
        <PinList pins={pins} parts={live} onClear={(slug) => setPins(without(pins, slug))} />
        <HeadRow className="pm-row">
          {decidable && (
            <input
              className="pm-note"
              placeholder={
                Object.keys(pins).length > 0
                  ? 'Anything to add — your pinned parts are sent with this'
                  : 'Why (optional) — recorded either way'
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          {decidable && (
            <>
              <AsyncButton
                ghost
                title="Sends it back to the planner with your note. Parts nothing has started for are retired."
                onClick={() => onDecide(decidable.id, 'reject', composeNote(pins, live, note))}
              >
                Reject — send it back to the planner
              </AsyncButton>
              {/* The two ways out that are not about the plan. A rejection asks a
                    planner for a different plan, so it is the wrong "no" for a goal
                    that should not be worked at all — which is the reading this
                    panel, where the plan has actually been read, most often produces. */}
              <AsyncButton
                ghost
                // The note is posted on the tracker as the closing comment, so a
                // close with an empty box would shut somebody's ticket for a
                // reason nobody can read.
                disabled={note.trim().length === 0}
                title={
                  note.trim().length === 0
                    ? 'Say why in the box — your words go on the ticket as the closing comment'
                    : 'Comments with your words, closes the ticket, stops watching it and abandons this plan'
                }
                onClick={() => onBackOut(decidable.id, 'close', note.trim())}
              >
                Close the ticket
              </AsyncButton>
              <AsyncButton
                ghost
                title="Put a draft closing comment in the box to edit — nothing is posted until you close the ticket"
                onClick={async () => setNote(await onCommentDraft(decidable.id))}
              >
                Draft a comment
              </AsyncButton>
              <AsyncButton
                ghost
                title="Stops watching the ticket and sends this plan back to the planner. Nothing is scheduled for it — watch it again and a fresh plan is written."
                onClick={() => onBackOut(decidable.id, 'hold', note.trim() || undefined)}
              >
                Hold — stop watching
              </AsyncButton>
              {issueNumber !== null && (
                <DesktopLink
                  className={buttonClass({ ghost: true })}
                  folder={desktopFolder}
                  prompt={discussPrompt(issueNumber)}
                  explain={discuss}
                >
                  Discuss…
                </DesktopLink>
              )}
              <AsyncButton
                tone="primary"
                // Held, not hidden: the checklist above says what is outstanding
                // and the hint on the button says how many. The route refuses it
                // either way — this is that answer, a step earlier.
                disabled={held}
                title={
                  held
                    ? heldTitle(ack.outstanding)
                    : 'Release the plan — each part gets its own agent, branch and pull request'
                }
                onClick={() => onDecide(decidable.id, 'accept', composeNote(pins, live, note), ack.acknowledged)}
              >
                {approveLabel(live, queued, originOf)}
              </AsyncButton>
            </>
          )}
          {!decidable && (
            <span className="muted small">
              {spend === null
                ? 'Nothing measured for this goal yet'
                : `This goal has cost $${spend.costUsd.toFixed(2)} so far`}
              {' · updated '}
              {relTime(plan.updatedAt, now)}
            </span>
          )}
          <span className="spacer" />
          {/* Offered on both statuses `plan_amend` settles, and no others: it
                rewrites an `awaiting_approval` plan and proposes against a running
                one. A control that offered what the tool refuses is a session sent
                to argue about a plan it cannot then change. */}
          {(plan.status === 'awaiting_approval' || plan.status === 'active') && !decidable && issueNumber !== null && (
            <DesktopLink
              className={buttonClass({ ghost: true })}
              folder={desktopFolder}
              prompt={discussPrompt(issueNumber)}
              explain={discuss}
            >
              Discuss…
            </DesktopLink>
          )}
          <AsyncButton
            ghost
            title="Ask the planner again from the plan's current state. Nothing is torn down."
            onClick={() => onReplan(plan.id)}
          >
            Replan
          </AsyncButton>
        </HeadRow>
      </div>
    </Modal>
  );
}

/** An operator's mark on one part while they read — see {@link PinList}. */
type Pin = 'drop' | 'ask';

/**
 * A plan's revisions, fetched when the sheet opens.
 *
 * Keyed on `plan.updatedAt` as well as the id, so an amendment that lands while
 * the sheet is open refetches: the whole point of the History view is to be
 * current about a plan that has just changed under the reader.
 *
 * A failure resolves to null and the rail simply offers no History — an error
 * banner for a view nobody has asked for yet would be louder than the fact.
 */
function usePlanHistory(planId: string, updatedAt: string): PlanHistory | null {
  const [history, setHistory] = useState<PlanHistory | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getPlanHistory(planId)
      .then((res) => {
        if (live) setHistory(res);
      })
      .catch(() => {
        if (live) setHistory(null);
      });
    return () => {
      live = false;
    };
  }, [planId, updatedAt]);
  return history;
}

/**
 * What approving this plan actually starts, in numbers the operator would
 * otherwise have to count off the list themselves.
 *
 * Every figure is read off state that already exists — the parts, the last pulse's
 * queue, and `maxConcurrentPartsPerIssue`. **Nothing here is a forecast**: there is
 * no estimate of what the work will cost, because the harness has no way to make
 * one and a made-up number on the button that authorises spending is worse than no
 * number. The spend shown is what has already been spent.
 */
function Decision({
  parts,
  planning,
  spend,
  queued,
  originOf,
  issueNumber,
}: {
  parts: PlanPartView[];
  planning: PlanningPolicy;
  spend: IssueSpend | null;
  queued: Map<string, QueueItem>;
  originOf: (slug: string) => string;
  issueNumber: number | null;
}) {
  const human = parts.filter((p) => p.expectedKind === 'human');
  const agentParts = parts.filter((p) => p.expectedKind !== 'human');
  // A part that ends in a report or a determination produces no pull request, so
  // counting every part as one would overstate what lands in review.
  const prs = agentParts.filter((p) => p.expectedKind === null || p.expectedKind === 'code');
  const startsNow = agentParts.filter((p) => queued.get(originOf(p.slug)) !== undefined && p.dependsOn.length === 0);
  const large = parts.filter((p) => p.size === 'l');
  const stats: { n: string; label: string; warn?: boolean }[] = [
    { n: String(parts.length === 0 ? 1 : prs.length), label: parts.length === 0 ? 'pull request' : 'pull requests' },
    { n: String(parts.length === 0 ? 1 : agentParts.length), label: 'agents, over time' },
    { n: String(Math.max(1, planning.maxConcurrentPartsPerIssue)), label: 'at once, max' },
    { n: String(parts.length === 0 ? 1 : Math.max(startsNow.length, 1)), label: 'starts immediately' },
  ];
  if (human.length > 0)
    stats.push({ n: String(human.length), label: human.length === 1 ? 'step for you' : 'steps for you' });
  if (large.length > 0) stats.push({ n: String(large.length), label: 'large to review', warn: true });
  if (spend !== null) stats.push({ n: `$${spend.costUsd.toFixed(2)}`, label: 'spent getting here', warn: true });

  return (
    <div className="pm-authorising">
      {stats.map((s) => (
        <div className={`pm-stat${s.warn === true ? ' warn' : ''}`} key={s.label}>
          <b>{s.n}</b>
          <span>{s.label}</span>
        </div>
      ))}
      <span className="spacer" />
      {issueNumber !== null && parts.length > 0 && (
        <span className="pm-branches">
          on <code>issue/{issueNumber}/…</code>
        </span>
      )}
    </div>
  );
}

/** The Approve button says what starts, because that is what the click does. */
function approveLabel(
  parts: PlanPartView[],
  queued: Map<string, QueueItem>,
  originOf: (slug: string) => string,
): string {
  if (parts.length === 0) return 'Approve — work it as one PR';
  const now = parts.filter(
    (p) => p.expectedKind !== 'human' && p.dependsOn.length === 0 && queued.has(originOf(p.slug)),
  );
  const count = Math.max(now.length, 1);
  return `Approve — start ${count} agent${count === 1 ? '' : 's'} now`;
}

/**
 * The objections an operator pinned while reading, gathered above the note box.
 *
 * **They compose the note the two verdicts already carry** — no new mechanic, no
 * new route, nothing the server has to learn. Reading a five-part plan and
 * disagreeing with one of them is the ordinary case, and until now the only way to
 * say so was to remember the slug and type it into a free-text box at the bottom.
 */
function PinList({
  pins,
  parts,
  onClear,
}: {
  pins: Record<string, Pin>;
  parts: PlanPartView[];
  onClear: (slug: string) => void;
}) {
  const entries = Object.entries(pins).filter(([slug]) => parts.some((p) => p.slug === slug));
  if (entries.length === 0) return null;
  return (
    <div className="pm-pins">
      <span className="pm-section-label">Sent with your verdict</span>
      {entries.map(([slug, pin]) => (
        <span key={slug} className={`pm-pin on ${pin}`}>
          {pinText(slug, pin)}
          <button className="pm-pin-x" title="Remove" onClick={() => onClear(slug)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function pinText(slug: string, pin: Pin): string {
  return pin === 'drop' ? `drop “${slug}”` : `question “${slug}”`;
}

/** The pinned objections and the free text as the one note the verdict carries. */
function composeNote(pins: Record<string, Pin>, parts: PlanPartView[], note: string): string | undefined {
  const lines = Object.entries(pins)
    .filter(([slug]) => parts.some((p) => p.slug === slug))
    .map(([slug, pin]) => pinText(slug, pin));
  const text = [...lines, note.trim()].filter((s) => s !== '').join('; ');
  return text === '' ? undefined : text;
}

function without(pins: Record<string, Pin>, slug: string): Record<string, Pin> {
  const next = { ...pins };
  delete next[slug];
  return next;
}

/**
 * The planner's citations, as links into the code it read.
 *
 * Rendered as plain monospace rather than as repository links: the cockpit has no
 * source browser and `refUrls` answers only for tracker items, so a link here
 * would go nowhere. The path and line are what someone with the repository open
 * needs, and they are selectable.
 */
function Evidence({ evidence }: { evidence: PlanEvidence[] }) {
  return (
    <div className="pm-cites">
      {evidence.map((cite, i) => (
        <div className="pm-cite" key={`${cite.path}:${cite.line ?? ''}:${i}`}>
          <code>
            {cite.path}
            {cite.line === null ? '' : `:${cite.line}`}
          </code>
          {cite.note !== null && <em>{cite.note}</em>}
        </div>
      ))}
    </div>
  );
}

/**
 * One folded caveat — the planner's prose about what it rejected, what it is
 * unsure of, what could go wrong, or what it left alone. Shut by default with its
 * opening words on the summary line, because each runs to several hundred words at
 * the length a planner naturally writes them, and four of them open above the
 * Approve button is four walls where the answer to "what are we doing" is none of
 * them. Folded is not hidden: the preview line is there so the fold is a decision
 * you make, not one made for you.
 */
function Caveat({
  kind,
  label,
  body,
  refUrls,
  open,
}: {
  kind: 'risk' | 'oos' | 'alt' | 'open';
  label: string;
  body: string;
  refUrls: Record<string, string>;
  open?: boolean;
}) {
  return (
    <details className={`pm-flag ${kind}`} open={open}>
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
  focused,
  pin,
  pinnable,
  onPin,
  onAcceptance,
  onPartProfile,
  onRestart,
  profiles,
  defaultProfile,
}: {
  part: PlanPartView;
  seq: number;
  queue: QueueItem | undefined;
  focused: boolean;
  pin: Pin | undefined;
  /** Pins are offered only while there is a verdict for them to ride on. */
  pinnable: boolean;
  onPin: (pin: Pin) => void;
  onAcceptance: (criterion: string, met: boolean) => Promise<unknown> | unknown;
  onPartProfile: (profile: string | null) => Promise<unknown> | unknown;
  /**
   * Undefined where this deployment's provider cannot close a pull request — the
   * control is then absent rather than drawn and refused.
   */
  onRestart: (() => Promise<unknown> | unknown) | undefined;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
}) {
  return (
    <div className={`pm-part${focused ? ' on' : ''}`}>
      <span className="pm-seq">{seq}</span>
      <div>
        <div className="pm-part-head">
          <span className="pm-part-title">{part.title}</span>
          <span className="chip small mono">{part.slug}</span>
          <span className="chip small">{part.status.replace('_', ' ')}</span>
          {/* This is the surface plan approval exists for: seeing that step 3 is
              "write it up" rather than "build it" is what an operator is approving.
              Shown only when the kind is not code, which is the default. */}
          {kindOf(part) && (
            <span
              className="chip small"
              title={part.status === 'concluded' ? 'What it produced' : 'What it will produce'}
            >
              {kindOf(part)}
            </span>
          )}
          {part.size !== null && (
            <span className="chip small mono" title="How big this is to review, as the planner judged it">
              {part.size.toUpperCase()}
            </span>
          )}
          {/* Which model profile this part runs on (#342) — the planner's own
              sizing of the part it just cut, edited. Beside the size chip because
              they are the same judgement about the same thing: how much this part
              is going to take. */}
          <ProfilePicker
            profiles={profiles}
            value={part.profile ?? null}
            defaultProfile={defaultProfile}
            inheritLabel="Inherit"
            onPick={(profile) => void onPartProfile(profile)}
          />
          {part.prNumber !== null && (
            <span className="chip small">
              <Ref to={`pr:${part.prNumber}`} />
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
          {/* Only where it applies: a part in review has a pull request open and no
              agent on it (an agent still working is `dispatched`), which is exactly
              the state an amendment overtakes. Two clicks, because closing somebody's
              open pull request is not undoable from here. */}
          {onRestart && part.status === 'in_review' && part.prNumber !== null && (
            <ConfirmButton
              size="small"
              label="↺ restart"
              confirmLabel="close the PR and restart"
              title={`Close PR #${part.prNumber}, drop its branch, and put "${part.slug}" back to ready so it is worked again against the plan as it stands now.`}
              onConfirm={onRestart}
            />
          )}
          {pinnable && (
            <span className="pm-part-pins">
              <button
                className={`pm-pin ask${pin === 'ask' ? ' on' : ''}`}
                title="Flag this part in the note your verdict carries"
                onClick={() => onPin('ask')}
              >
                ? question
              </button>
              <button
                className={`pm-pin drop${pin === 'drop' ? ' on' : ''}`}
                title="Ask for this part to be dropped, in the note your verdict carries"
                onClick={() => onPin('drop')}
              >
                ✕ drop
              </button>
            </span>
          )}
        </div>
        {part.touches.length > 0 ? (
          <div className="pm-touches">
            {part.touches.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        ) : (
          <div className="pm-scope">{part.scope}</div>
        )}
        {/* Both, when both say something different: the prose says what the part is
            for and the paths say what it may write, and only the second can be
            checked. A planner that answered both with the same path list has said
            one thing, and printing it twice reads as a rendering bug. */}
        {part.touches.length > 0 && part.scope !== '' && !sameAsTouches(part) && (
          <div className="pm-scope">{part.scope}</div>
        )}
        {part.outsideScope.length > 0 && (
          <div className="pm-drift">
            <b>wrote outside its scope</b>
            {part.outsideScope.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        )}
        {part.rationale && (
          <div className="pm-field">
            <b>why its own PR</b>
            {part.rationale}
          </div>
        )}
        {part.acceptanceCriteria.length > 0 && (
          <Acceptance criteria={part.acceptanceCriteria} onAcceptance={onAcceptance} />
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
        {part.status === 'blocked' && part.blockedReason && (
          <div className="pm-drift">
            <b>held</b>
            {part.blockedReason}
          </div>
        )}
        {/*
          Spelled out rather than left as an `on <slug>` chip: the stack edge is
          what decides which branch this part is cut from, and getting it wrong is
          the one planning mistake that is expensive to undo.
        */}
        <div className="pm-stack">{stackLine(part)}</div>
      </div>
    </div>
  );
}

/** Did the planner answer `scope` and `touches` with the same thing? */
function sameAsTouches(part: PlanPartView): boolean {
  const flat = (text: string): string => text.replace(/[\s,]+/g, ' ').trim();
  return flat(part.scope) === flat(part.touches.join(' '));
}

/** How this part is based, in the words that say what it waits for. */
function stackLine(part: PlanPartView): string {
  if (part.expectedKind === 'human') {
    return part.dependsOn.length === 0
      ? 'a step for a person — no branch is cut for it'
      : `a step for a person, once ${quoteList(part.dependsOn)} ${part.dependsOn.length === 1 ? 'is' : 'are'} done`;
  }
  if (part.dependsOn.length === 0) return 'stacks on nothing — starts from the default branch';
  if (part.dependsOn.length === 1) return `stacks on ${quoteList(part.dependsOn)} — based on that part's branch`;
  return `rejoins ${quoteList(part.dependsOn)} — starts only once every one of them has merged, from the default branch`;
}

function quoteList(slugs: string[]): string {
  const quoted = slugs.map((s) => `“${s}”`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * A part's acceptance criteria, as a checklist a reviewer ticks.
 *
 * **The tick is the reviewer's, never the harness's.** Nothing here derives
 * whether a criterion holds: inferring a positive terminal from incidental
 * evidence is what the harness refuses everywhere else, and a criterion the
 * cockpit ticked itself would be a claim nobody made. What this adds is that the
 * criteria are in front of the merged pull request instead of in a plan nobody
 * reopens.
 */
function Acceptance({
  criteria,
  onAcceptance,
}: {
  criteria: AcceptanceCriterion[];
  onAcceptance: (criterion: string, met: boolean) => Promise<unknown> | unknown;
}) {
  return (
    <div className="pm-accept">
      <b>done when</b>
      <div>
        {criteria.map((c) => (
          <label className={`pm-crit${c.met ? ' met' : ''}`} key={c.text}>
            <input type="checkbox" checked={c.met} onChange={() => void onAcceptance(c.text, !c.met)} />
            <span>{c.text}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * What the last amendment did — the view a replan or a discussion opens on.
 *
 * The diff is the server's (`diffPlanRevisions`), so what is drawn here and what
 * the store believes about the merge on slug are one reading. Prose fields are
 * **named rather than diffed word by word**: a planner rewrites a paragraph whole,
 * so a word-level diff of one is two paragraphs marked entirely changed.
 */
function HistoryView({ history, now }: { history: PlanHistory | null; now: number }) {
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
          <span className={`chip small${rev === latest ? ' ok' : ''}`} key={rev.id} title={rev.narrative.reason ?? ''}>
            v{rev.seq} · {rev.parts.length} part{rev.parts.length === 1 ? '' : 's'} · {relTime(rev.at, now)}
          </span>
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

/**
 * The change waiting on the operator, on the sheet where the plan is actually
 * read.
 *
 * The inbox card asks the question; this says the same thing where somebody has
 * gone to look at the plan itself, because the two readings would otherwise
 * disagree by omission — a plan sheet that showed a running decomposition with no
 * sign that a correction to it was pending reads as a plan nobody has questioned.
 *
 * **No verdict here.** Accepting or declining is the proposal's, on its card, and
 * a second pair of buttons over one decision is two places for it to be answered
 * differently. What this surface owes the reader is the case and its consequences.
 *
 * The diff is the server's `proposedPlanDiff` and is drawn through the same
 * {@link DiffBody} as an applied one: a change must not look like a different kind
 * of thing either side of the decision that applies it.
 */
function PendingAmendment({ pending, now }: { pending: PendingPlanAmendment; now: number }) {
  return (
    <section className="pm-pending">
      <HeadRow align="baseline" className="pm-pending-head">
        <span className="pm-section-label">Waiting on you</span>
        <span className="chip small warn">amendment</span>
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

/**
 * The tag's tone alias per kind of change, beside the kind's own class: the class
 * is what the row is, the alias is where the hue, the border and the fill come
 * from. An unchanged part is never drawn here, and prose has no tone at all.
 * → docs/spec/17-cockpit.md#the-tag
 */
const DIFF_TONE = { added: 't-green', dropped: 't-red', changed: 't-blue', unchanged: '' };

function DiffBody({ diff }: { diff: PlanDiff }) {
  const moved = diff.parts.filter((p) => p.kind !== 'unchanged');
  const unchanged = diff.parts.length - moved.length;
  return (
    <>
      <div className="pm-diff-head">
        <span className="pm-section-label">
          v{diff.seq} against v{diff.againstSeq}
        </span>
        {moved.length === 0 && <span className="chip small">no part changed</span>}
        {unchanged > 0 && <span className="chip small">{unchanged} unchanged</span>}
      </div>
      {moved.map((change) => (
        <div className="pm-diff-row" key={change.slug}>
          <span className={`pm-dtag ${change.kind} ${DIFF_TONE[change.kind]}`}>
            {change.kind === 'dropped' ? 'no longer' : change.kind}
          </span>
          <div>
            <div className="pm-part-head">
              <span className="pm-part-title">{change.title}</span>
              <span className="chip small mono">{change.slug}</span>
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
          <span className="pm-dtag prose">prose</span>
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

/**
 * What a part produced, or is expected to produce — null when that is code, which
 * is every ordinary part and would be noise on each row.
 */
function kindOf(part: PlanPartView): string | null {
  const kind = part.status === 'concluded' ? (part.outcomeKind ?? 'concluded') : (part.expectedKind ?? null);
  return kind && kind !== 'code' ? kind : null;
}
