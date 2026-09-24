import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import type {
  GoalWatch,
  CaveatAnswerInput,
  IssueSpend,
  PlanAtom,
  PlanCaveat,
  PlanCaveatAnswer,
  Plan,
  PlanHistory,
  PlanPartView,
  PlanningPolicy,
  Proposal,
  QueueItem,
  StateQuery,
  ValidationCheckView,
  ValidationPlanRecord,
} from '../types.js';
import { api } from '../api.js';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from './DesktopLink.js';
import { CaveatChecklist, useAcknowledgements } from './CaveatChecklist.js';
import { planCaveatsOf } from '../planCaveats.js';
import { AsyncButton } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { PlanAnswers } from './PlanAnswers.js';
import { PlanMap } from './PlanMap.js';
import { PlanRegroup } from './PlanRegroup.js';
import { ProofBand, proofCounts, type ProofCell } from './ProofBand.js';
import { StateDigest } from './StateDigest.js';
import { ValidationDigest } from './ValidationSection.js';
import { WatchDigest } from './WatchDigest.js';
import { partOriginOf, planIssueOf, refLink, relTime } from './util.js';
import { Modal } from './Modal.js';
import { Ref } from './refs.js';
import { PartBlock } from './PlanPart.js';
import { HistoryView } from './PlanHistoryView.js';
import { HeadRow } from './panel.js';
import { Tag } from './tag.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

interface PlanModalProps {
  plan: Plan;
  parts: PlanPartView[];
  atoms: PlanAtom[];
  checks: ValidationCheckView[];
  validationPlan: ValidationPlanRecord | null;
  caveatAnswers: PlanCaveatAnswer[];
  watches: GoalWatch[];
  queries: StateQuery[];
  upcoming: QueueItem[];
  proposal?: Proposal;
  spend: IssueSpend | null;
  planning: PlanningPolicy;
  now: number;
  refUrls: Record<string, string>;
  onClose: () => void;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onWatchProposal: (issueNumber: number, checkId: string, accept: boolean) => Promise<unknown> | unknown;
  onDecide: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
    answers?: CaveatAnswerInput[],
  ) => Promise<unknown> | unknown;
  onBackOut: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
  onOpenGoal: (issueRef: string) => void;
  onPartProfile: (planId: string, slug: string, profile: string | null) => Promise<unknown> | unknown;
  onRestartPart: (planId: string, slug: string) => Promise<unknown> | unknown;
  regrouping?: boolean;
  onRegroupView?: (on: boolean) => void;
  onRegroup?: (
    planId: string,
    groups: { slug: string; atoms: string[]; title?: string; scope?: string }[],
  ) => Promise<unknown> | unknown;
  canClosePr: boolean;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
  desktopFolder: string;
}

type Sections = MutableRefObject<Record<string, HTMLElement | null>>;
type Acknowledgements = ReturnType<typeof useAcknowledgements>;
type SheetView = 'plan' | 'history';

/** What the modal derives once and every part of the sheet reads. */
interface Derived {
  live: PlanPartView[];
  queued: Map<string, QueueItem>;
  originOf: (slug: string) => string;
  issueNumber: number | null;
  decidable: Proposal | null;
  caveats: PlanCaveat[];
  ack: Acknowledgements;
  sections: Sections;
}

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

function PlanRail({
  checks,
  watches,
  queries,
  onRegroupView,
  live,
  decidable,
  caveats,
  ack,
  jump,
  regroupable,
  regroup,
  history,
  view,
  setView,
}: PlanModalProps &
  Derived & {
    jump: (key: string) => void;
    regroupable: boolean;
    regroup: boolean;
    history: PlanHistory | null;
    view: SheetView;
    setView: (view: SheetView) => void;
  }) {
  const liveChecks = checks.filter((c) => c.supersededReason === null);
  const settledChecks = liveChecks.filter((c) => c.state === 'passed' || c.state === 'waived').length;
  const held = ack.outstanding.length > 0;
  return (
    <div className="pm-rail">
      <button className="pm-jump" onClick={() => jump('verdict')}>
        Verdict
      </button>
      <button className="pm-jump" onClick={() => jump('proof')}>
        Proof{' '}
        <i className="k">
          {proofCounts(checks, live, watches, queries)
            .map((c) => c.count)
            .join(' · ')}
        </i>
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
      {/* The one tab that can be asking for something. The checklist lives in the
          section below now, so an operator who reaches for a held Approve without
          having scrolled that far has nothing on the sheet telling them where the
          boxes are — the rail is where they are already looking, and the count is
          the way back. Amber while any box is outstanding, plain the moment the
          last one is ticked. */}
      <button className={`pm-jump${held ? ' waiting' : ''}`} onClick={() => jump('caveats')}>
        Caveats
        {decidable && caveats.length > 0 && (
          <i className="k">
            {caveats.length - ack.outstanding.length}/{caveats.length}
          </i>
        )}
      </button>
      <button className="pm-jump" onClick={() => jump('writeup')}>
        Write-up
      </button>
      <span className="spacer" />
      <ViewToggles
        onRegroupView={onRegroupView}
        regroupable={regroupable}
        regroup={regroup}
        history={history}
        view={view}
        setView={setView}
      />
    </div>
  );
}

function ViewToggles({
  onRegroupView,
  regroupable,
  regroup,
  history,
  view,
  setView,
}: {
  onRegroupView: ((on: boolean) => void) | undefined;
  regroupable: boolean;
  regroup: boolean;
  history: PlanHistory | null;
  view: SheetView;
  setView: (view: SheetView) => void;
}) {
  return (
    <>
      {/* A view, not a jump — a different document, so it reads as a different
            control. Absent until there is a second revision to be a change from,
            or a change waiting on the operator to be asked about. */}
      {regroupable && (
        <button
          className={`pm-jump history${regroup ? ' on' : ''}`}
          title="Move an atom from one part to another — the work is the same, the merge boundaries are not"
          onClick={() => onRegroupView?.(!regroup)}
        >
          {regroup ? 'Back to the plan' : 'Regroup'}
        </button>
      )}
      {history !== null && (history.revisions.length > 1 || history.pending !== null) && (
        <button
          className={`pm-jump history${view === 'history' ? ' on' : ''}${history.pending ? ' waiting' : ''}`}
          onClick={() => {
            if (view !== 'history') logUsage('plan.expand');
            setView(view === 'history' ? 'plan' : 'history');
          }}
        >
          {/* A change waiting on the operator outranks the history it would
                become: it is the one thing on this sheet that is asking them
                something, and it is why the control is offered at all on a plan
                with a single revision. */}
          {history.pending ? 'Change waiting' : history.diff === null ? 'History' : 'What changed'}{' '}
          <i className="k">v{history.revisions.length}</i>
        </button>
      )}
    </>
  );
}

function JumpSection({
  at,
  sections,
  className,
  children,
}: {
  at: string;
  sections: Sections;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      ref={(el) => {
        sections.current[at] = el;
      }}
      className={className}
    >
      {children}
    </section>
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

function CaveatsSection({ plan, caveatAnswers, refUrls, decidable, caveats, ack, sections }: PlanModalProps & Derived) {
  return (
    <JumpSection at="caveats" sections={sections} className="pm-flags">
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
      {/* The boxes sit with the caveats they are about, inside the scroll,
          rather than above the buttons. In the decision bar the list was a
          second scroll container competing with the plan for the sheet's
          height, and the operator read the plan through a slot; here it is
          the last thing in the section the rail's Caveats jump lands on,
          and the plan gets the whole middle back. */}
      {/* What the operator wrote beside the boxes when they released it.
          Later than the plan and above the fold of the write-up, because a
          choice made at the verdict is what the parts are actually being
          worked to. */}
      {caveatAnswers.length > 0 && (
        <div className="pm-answers">
          <span className="pm-section-label">Answered at approval</span>
          {caveatAnswers.map((a) => (
            <div key={a.id} className="pm-answer">
              <span className="muted small">{a.label}</span>
              <div className="pm-prose">{renderMarkdown(a.answer, refUrls)}</div>
            </div>
          ))}
        </div>
      )}
      {decidable && (
        <CaveatChecklist
          caveats={caveats}
          ticked={ack.ticked}
          answers={ack.written}
          onToggle={ack.toggle}
          onAnswer={ack.answer}
          refUrls={refUrls}
        />
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
      {/* On the summary rather than on the `details` toggle event, so only an
       *opening* is a reading: a fold shut is not somebody reading a caveat. */}
      <summary
        className="pm-flag-head"
        onClick={(e) => {
          if (e.currentTarget.parentElement?.matches('[open]') !== true) logUsage('plan.expand');
        }}
      >
        <span className="pm-section-label">{label}</span>
        <span className="pm-flag-teaser">{teaser(body)}</span>
      </summary>
      <div className="pm-prose">{renderMarkdown(body, refUrls)}</div>
    </details>
  );
}

function teaser(body: string): string {
  const flat = body
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 110 ? `${flat.slice(0, 110).trimEnd()}…` : flat;
}

function partInFlight(part: PlanPartView): boolean {
  return (
    part.status === 'dispatched' ||
    part.status === 'in_review' ||
    part.status === 'merged' ||
    part.status === 'concluded'
  );
}
