import { useEffect, useRef, useState } from 'react';
import type {
  AcceptanceCriterion,
  GoalWatch,
  CaveatAnswerInput,
  IssueSpend,
  PlanCaveatAnswer,
  Plan,
  PlanDiff,
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
import { CaveatChecklist, useAcknowledgements } from './CaveatChecklist.js';
import { planCaveatsOf } from '../planCaveats.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { PlanAnswers } from './PlanAnswers.js';
import { PlanMap } from './PlanMap.js';
import { ProfilePicker } from './ProfilePicker.js';
import { ValidationDigest } from './ValidationSection.js';
import { WatchDigest } from './WatchDigest.js';
import { partOriginOf, planIssueOf, refLink, relTime } from './util.js';
import { Modal } from './Modal.js';
import { Ref } from './refs.js';
import { HeadRow } from './panel.js';
import { Tag, type TagTone } from './tag.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

export function PlanModal({
  plan,
  parts,
  checks,
  caveatAnswers,
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
  onOpenGoal,
  onPartProfile,
  onRestartPart,
  canClosePr,
  profiles,
  defaultProfile,
  desktopFolder,
}: {
  plan: Plan;
  parts: PlanPartView[];
  checks: ValidationCheck[];
  caveatAnswers: PlanCaveatAnswer[];
  watches: GoalWatch[];
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
  canClosePr: boolean;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
  desktopFolder: string;
}) {
  const [view, setView] = useState<'plan' | 'history'>('plan');
  const [focused, setFocused] = useState<string | null>(null);
  const history = usePlanHistory(plan.id, plan.updatedAt);
  const body = useRef<HTMLDivElement>(null);
  const sections = useRef<Record<string, HTMLElement | null>>({});

  const live = parts.filter((p) => p.status !== 'retired');
  const settled = live.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
  const liveChecks = checks.filter((c) => c.supersededReason === null);
  const settledChecks = liveChecks.filter((c) => c.state === 'passed' || c.state === 'waived').length;
  const issueNumber = planIssueOf(plan.originRef);
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  const decidable = proposal?.status === 'pending' ? proposal : null;
  const caveats = planCaveatsOf(decidable ?? undefined);
  const ack = useAcknowledgements(caveats);
  const held = ack.outstanding.length > 0;
  const headline = plan.approach ?? plan.reason;
  const shapeNote = plan.approach ? plan.reason : null;
  const cutAt = live.findIndex((p) => {
    const q = queued.get(partOriginOf(issueNumber, p.slug));
    return q !== undefined && q.status !== 'dispatching';
  });
  const originOf = (slug: string): string => partOriginOf(issueNumber, slug);
  const discuss =
    plan.status === 'active'
      ? 'so the plan is talked through with a session that can propose a change to it — the plan keeps running while you decide, and nothing changes until you accept.'
      : 'so the plan is talked through with a session that can amend it — nothing is scheduled, and nothing changes until it does.';

  const jump = (key: string): void => {
    setView('plan');
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
        {/* A view, not a jump — a different document, so it reads as a different
              control. Absent until there is a second revision to be a change from,
              or a change waiting on the operator to be asked about. */}
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
    </Modal>
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

function PartBlock({
  part,
  seq,
  queue,
  focused,
  onPartProfile,
  onRestart,
  profiles,
  defaultProfile,
}: {
  part: PlanPartView;
  seq: number;
  queue: QueueItem | undefined;
  focused: boolean;
  onPartProfile: (profile: string | null) => Promise<unknown> | unknown;
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
          <Tag lower>{part.slug}</Tag>
          <Tag>{part.status.replace('_', ' ')}</Tag>
          {/* This is the surface plan approval exists for: seeing that step 3 is
              "write it up" rather than "build it" is what an operator is approving.
              Shown only when the kind is not code, which is the default. */}
          {kindOf(part) && (
            <Tag title={part.status === 'concluded' ? 'What it produced' : 'What it will produce'}>{kindOf(part)}</Tag>
          )}
          {part.size !== null && (
            <Tag lower title="How big this is to review, as the planner judged it">
              {part.size.toUpperCase()}
            </Tag>
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
            <Tag>
              <Ref to={`pr:${part.prNumber}`} />
            </Tag>
          )}
          {queue && (
            <Tag
              tone={
                queue.status === 'dispatching'
                  ? 'green'
                  : queue.status === 'capped' || queue.status === 'unapproved'
                    ? 'amber'
                    : undefined
              }
              title={queue.reason}
            >
              {queue.status === 'dispatching' ? '▶ now' : queue.status}
            </Tag>
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
        </div>
        {part.scope !== '' && (
          <div className="pm-field">
            <b>what this achieves</b>
            {part.scope}
          </div>
        )}
        {part.outsideScope.length > 0 && (
          <div className="pm-drift">
            <b>wrote outside its scope</b>
            {part.outsideScope.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        )}
        {part.acceptanceCriteria.length > 0 && <Acceptance criteria={part.acceptanceCriteria} />}
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

function Acceptance({ criteria }: { criteria: AcceptanceCriterion[] }) {
  return (
    <div className="pm-accept">
      <b>done when</b>
      <div>
        {criteria.map((c) => (
          <span className={`pm-crit${c.met ? ' met' : ''}`} key={c.text}>
            <span>{c.text}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

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

function kindOf(part: PlanPartView): string | null {
  const kind = part.status === 'concluded' ? (part.outcomeKind ?? 'concluded') : (part.expectedKind ?? null);
  return kind && kind !== 'code' ? kind : null;
}
