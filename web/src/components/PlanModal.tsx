import { useEffect, useRef, useState } from 'react';
import type { Plan, PlanHistory, PlanPartView } from '../types.js';
import { api } from '../api.js';
import { useAcknowledgements } from './CaveatChecklist.js';
import { planCaveatsOf } from '../planCaveats.js';
import { renderMarkdown } from './markdown.js';
import { PlanMap } from './PlanMap.js';
import { PlanRegroup } from './PlanRegroup.js';
import { ProofBand, type ProofCell } from './ProofBand.js';
import { StateDigest } from './StateDigest.js';
import { ValidationDigest } from './ValidationSection.js';
import { WatchDigest } from './WatchDigest.js';
import { partOriginOf, planIssueOf, refLink, relTime } from './util.js';
import { Modal } from './Modal.js';
import { Ref } from './refs.js';
import { PartBlock } from './PlanPart.js';
import { HistoryView } from './PlanHistoryView.js';
import { Tag } from './tag.js';
import { logUsage } from '../cockpit/usage.js';
import { JumpSection, type Derived, type PlanModalProps, type Sections, type SheetView } from './planModalShared.js';
import { CaveatsSection } from './PlanCaveatsSection.js';
import { PlanRail } from './PlanRail.js';
import { Decision, approveLabel } from './PlanDecision.js';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from './DesktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { PlanAnswers } from './PlanAnswers.js';
import { HeadRow } from './panel.js';

// → docs/spec/17-cockpit.md

export function PlanModal(props: PlanModalProps) {
  const { plan, parts, atoms, upcoming, proposal, refUrls, onClose, regrouping, onRegroupView, onRegroup, now } = props;
  const [view, setView] = useState<SheetView>('plan');
  const regroupable = atoms.length > 0 && plan.status === 'awaiting_approval' && !parts.some(partInFlight);
  const regroup = regrouping === true && regroupable;
  const [focused, setFocused] = useState<string | null>(null);
  const history = usePlanHistory(plan.id, plan.updatedAt);
  const sections = useRef<Record<string, HTMLElement | null>>({});

  const live = parts.filter((p) => p.status !== 'retired');
  const settled = live.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
  const issueNumber = planIssueOf(plan.originRef);
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  const decidable = proposal?.status === 'pending' ? proposal : null;
  const caveats = planCaveatsOf(decidable ?? undefined);
  const ack = useAcknowledgements(caveats);
  const originOf = (slug: string): string => partOriginOf(issueNumber, slug);
  const derived: Derived = { live, queued, originOf, issueNumber, decidable, caveats, ack, sections };

  const jump = (key: string): void => {
    onRegroupView?.(false);
    setView('plan');
    requestAnimationFrame(() => sections.current[key]?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  // The band counts what four sections draw, so a cell lands on the section that
  // holds its rows rather than repeating them.
  const jumpProof = (cell: ProofCell): void =>
    jump(cell === 'suite' ? 'parts' : cell === 'manual' ? 'validation' : cell);
  const focusPart = (slug: string): void => {
    setFocused(slug);
    jump(`part:${slug}`);
  };

  return (
    <Modal
      face="sheet"
      title={plan.title}
      lead={<Ref to={plan.originRef} />}
      chips={
        <>
          <Tag tone={plan.status === 'complete' ? 'green' : decidable ? 'amber' : undefined}>
            {plan.status.replace(/_/g, ' ')}
          </Tag>
          {live.length > 0 && (
            <Tag>
              {settled}/{live.length} done
            </Tag>
          )}
          {/* The one comment the plan keeps on the ticket — where everyone who is
              not looking at this sheet reads the plan. */}
          {plan.statusCommentRef !== null && <Tag>{refLink(plan.statusCommentRef, refUrls)}</Tag>}
        </>
      }
      onClose={onClose}
    >
      <PlanRail
        {...props}
        {...derived}
        jump={jump}
        regroupable={regroupable}
        regroup={regroup}
        history={history}
        view={view}
        setView={setView}
      />

      <div className="pm-body">
        {regroup ? (
          <PlanRegroup
            parts={live}
            atoms={atoms}
            onRegroup={(groups) => onRegroup?.(plan.id, groups)}
            onClose={() => onRegroupView?.(false)}
          />
        ) : view === 'history' ? (
          <HistoryView history={history} now={now} />
        ) : (
          <PlanSheet {...props} {...derived} focused={focused} focusPart={focusPart} jumpProof={jumpProof} />
        )}
      </div>

      <PlanFoot {...props} {...derived} />
    </Modal>
  );
}

function PlanSheet(
  props: PlanModalProps &
    Derived & {
      focused: string | null;
      focusPart: (slug: string) => void;
      jumpProof: (cell: ProofCell) => void;
    },
) {
  const { plan, checks, watches, queries, refUrls, live, queued, originOf, sections, focused, focusPart, jumpProof } =
    props;
  const shapeNote = plan.approach ? plan.reason : null;
  return (
    <>
      <VerdictSection plan={plan} live={live} refUrls={refUrls} sections={sections} />

      <JumpSection at="proof" sections={sections}>
        {/* Under the verdict and above the shape, because it is the other
              half of the verdict: what we'll do, and what would show that it
              worked. Counts only — every row it stands for is drawn by the
              section it lands on, so the two can never disagree. */}
        <ProofBand checks={checks} parts={live} watches={watches} queries={queries} onJump={jumpProof} />
      </JumpSection>

      {live.length > 1 && (
        <JumpSection at="shape" sections={sections}>
          <span className="pm-section-label">The shape</span>
          {/* Normal case, under the label rather than inside it: `reason` is
                a sentence, and a sentence set in the label's letter-spaced
                uppercase is a sentence nobody reads. */}
          {shapeNote !== null && <div className="pm-shape">Split this way because: {shapeNote}</div>}
          <PlanMap parts={live} queued={queued} originOf={originOf} selected={focused} onSelect={focusPart} />
        </JumpSection>
      )}

      <PartsSection {...props} shapeNote={shapeNote} />

      <DigestSections {...props} />

      <CaveatsSection {...props} />

      <JumpSection at="writeup" sections={sections}>
        <span className="pm-section-label">The full write-up</span>
        {plan.document ? (
          <div className="pm-doc">{renderMarkdown(plan.document, refUrls)}</div>
        ) : (
          <p className="empty">
            This planner wrote no write-up. Replan to ask again, or discuss it if you want the reasoning.
          </p>
        )}
      </JumpSection>
    </>
  );
}

function DigestSections({
  checks,
  validationPlan,
  watches,
  queries,
  refUrls,
  onClose,
  onWatchProposal,
  onOpenGoal,
  issueNumber,
  sections,
}: PlanModalProps & Derived) {
  return (
    <>
      <JumpSection at="validation" sections={sections}>
        {/* Read-only, because the sheet defines the checks and the goal
              page runs them. A plan under review still has to show what it
              proposes to check — that is part of judging it — but a reading
              is recorded against the *goal*, and offering the verbs in two
              places is two wirings of one set of refusals. */}
        <ValidationDigest
          checks={checks}
          plan={validationPlan}
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
      </JumpSection>

      <JumpSection at="watch" sections={sections}>
        {/* Read-only for {@link ValidationDigest}'s reason, and below it
              deliberately: validation asks whether the goal was met, and this
              asks whether the thing is behaving once it is there — the later
              question, drawn later. Nothing renders where nothing was
              declared. */}
        <WatchDigest
          watches={watches}
          refUrls={refUrls}
          onRule={issueNumber === null ? null : (checkId, accept) => void onWatchProposal(issueNumber, checkId, accept)}
        />
      </JumpSection>

      <JumpSection at="state" sections={sections}>
        {/* Below the watch for the watch's own reason, one question further
              on: whether the thing works, whether it is behaving, and then
              whether the data it wrote is shaped the way the plan said. */}
        <StateDigest queries={queries} refUrls={refUrls} />
      </JumpSection>
    </>
  );
}

function VerdictSection({
  plan,
  live,
  refUrls,
  sections,
}: {
  plan: Plan;
  live: PlanPartView[];
  refUrls: Record<string, string>;
  sections: Sections;
}) {
  const headline = plan.approach ?? plan.reason;
  return (
    <JumpSection at="verdict" sections={sections} className="pm-verdict">
      {plan.diagnosis && (
        <div className="pm-vcell wrong">
          <span className="pm-section-label">What&rsquo;s wrong</span>
          <div className="pm-prose">{renderMarkdown(plan.diagnosis, refUrls)}</div>
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
    </JumpSection>
  );
}

function PartsSection({
  plan,
  atoms,
  onPartProfile,
  onRestartPart,
  canClosePr,
  profiles,
  defaultProfile,
  live,
  queued,
  originOf,
  decidable,
  sections,
  focused,
  shapeNote,
}: PlanModalProps & Derived & { focused: string | null; shapeNote: string | null }) {
  const byAtom = new Map(atoms.map((a) => [a.slug, a]));
  const cutAt = live.findIndex((p) => {
    const q = queued.get(originOf(p.slug));
    return q !== undefined && q.status !== 'dispatching';
  });
  return (
    <JumpSection at="parts" sections={sections}>
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
                  <span>{decidable ? 'nothing below is scheduled until you approve' : 'not started this cycle'}</span>
                </div>
              )}
              <PartBlock
                part={part}
                atoms={(part.atoms ?? []).flatMap((slug) => byAtom.get(slug) ?? [])}
                seq={idx + 1}
                queue={queued.get(originOf(part.slug))}
                focused={part.slug === focused}
                onPartProfile={(profile) => onPartProfile(plan.id, part.slug, profile)}
                onRestart={canClosePr ? () => onRestartPart(plan.id, part.slug) : undefined}
                profiles={profiles}
                defaultProfile={defaultProfile}
              />
            </div>
          ))}
        </>
      )}
    </JumpSection>
  );
}

function PlanFoot({
  plan,
  planning,
  spend,
  now,
  desktopFolder,
  onDecide,
  onBackOut,
  onReplan,
  live,
  queued,
  originOf,
  issueNumber,
  decidable,
  ack,
}: PlanModalProps & Derived) {
  const discuss =
    plan.status === 'active'
      ? 'so the plan is talked through with a session that can propose a change to it — the plan keeps running while you decide, and nothing changes until you accept.'
      : 'so the plan is talked through with a session that can amend it — nothing is scheduled, and nothing changes until it does.';
  return (
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
      {/* The four answers, the same component the inbox card draws. The sheet
          adds only `Decision` above them, which is the one thing it knows and the
          card does not: what approving *starts*. */}
      {decidable && (
        <PlanAnswers
          proposalId={decidable.id}
          issueNumber={issueNumber}
          approveLabel={approveLabel(live, queued, originOf)}
          outstanding={ack.outstanding}
          acknowledged={ack.acknowledged}
          answers={ack.answers}
          desktopFolder={desktopFolder}
          discussExplain={discuss}
          onDecide={onDecide}
          onBackOut={onBackOut}
        />
      )}
      {!decidable && (
        <HeadRow className="pm-row">
          <span className="muted small">
            {spend === null
              ? 'Nothing measured for this goal yet'
              : `This goal has cost $${spend.costUsd.toFixed(2)} so far`}
            {' · updated '}
            {relTime(plan.updatedAt, now)}
          </span>
          <span className="spacer" />
          {/* Offered on both statuses `plan_amend` settles, and no others: it
              rewrites an `awaiting_approval` plan and proposes against a running
              one. A control that offered what the tool refuses is a session sent
              to argue about a plan it cannot then change. */}
          {(plan.status === 'awaiting_approval' || plan.status === 'active') && issueNumber !== null && (
            <DesktopLink folder={desktopFolder} prompt={discussPrompt(issueNumber)} explain={discuss} />
          )}
          {/* Never beside a verdict. On a decidable plan this is "Change something
              first" with an empty note — the same route, the same outcome, and the
              one an operator reaches for when they have nothing to say, which is
              exactly the replan that re-runs the question that produced the plan
              being refused. Here, where there is no verdict on offer, it is the
              only way to ask a planner again. */}
          <AsyncButton
            ghost
            title="Ask the planner again from the plan's current state. Nothing is torn down."
            onClick={() => {
              logUsage('plan.reject');
              return onReplan(plan.id);
            }}
          >
            Replan
          </AsyncButton>
        </HeadRow>
      )}
    </div>
  );
}

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

function partInFlight(part: PlanPartView): boolean {
  return (
    part.status === 'dispatched' ||
    part.status === 'in_review' ||
    part.status === 'merged' ||
    part.status === 'concluded'
  );
}
