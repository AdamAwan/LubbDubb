import { useEffect, useState, type JSX } from 'react';
import type { ValidationCheckView, ValidationPlanRecord, ValidationResourceView } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { Button } from './button.js';
import type { ButtonLook } from './button.js';
import { Tag } from './tag.js';
import { CheckDetail, CHECK_STATE_WORDS } from './checkDetail.js';
import { BAND_HEADING, type CheckBand, type CheckStanding } from '../view/validatePane.js';
import { logUsage } from '../cockpit/usage.js';
import { CheckBlock, CheckLine, isMissingFile, stateTone } from './validationCheckRows.js';

// → docs/spec/17-cockpit.md

/**
 * What a goal with no checks on it actually means, which is three different things and only one of
 * them is *nobody planned any*. The planner declares the whole set after delivery, so an empty
 * section before that is a set not yet written, and an empty section after it can be a considered
 * answer — `emptyReason` is required of a planner that declares nothing, precisely so that answer is
 * on the record. Drawn from that record rather than derived: what a `coverage` part built is a fact
 * the planner read, and a second reading of it beside the planner's own sentence would be the
 * cockpit disagreeing with the agent that looked at the code.
 * → docs/spec/20-validation.md#saying-nothing-was-worth-running
 */
function EmptySet({ plan }: { plan: ValidationPlanRecord | null }) {
  if (plan?.emptyReason != null)
    return (
      <p className="empty">
        The planner read the delivered goal and decided nothing here needed checking.
        {plan.releasedAt == null && ' That is a verdict, and it is with you to accept in “Needs you”.'}
        <span className="pm-vnote">{plan.emptyReason}</span>
      </p>
    );
  if (plan?.authoredAt == null)
    return (
      <p className="empty">
        No checks yet. They are written against the merged code once this goal is delivered, so there is nothing to run
        here before then.
        {plan?.hint != null && <span className="pm-vnote">The plan asked for: {plan.hint}</span>}
      </p>
    );
  return (
    <p className="empty">
      No checks. Nothing confirms that this goal actually works beyond what the parts merged, so closing it is a
      judgement call rather than a verdict.
    </p>
  );
}

interface ValidationSectionProps {
  checks: ValidationCheckView[];
  plan: ValidationPlanRecord | null;
  issueNumber: number;
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  desktopFolder: string;
  /**
   * Where each check's answer is coming from, from the goal page. Absent on the surfaces that draw
   * the set without the runners beside it — the needs band and the plan sheet — where a band saying
   * *no run yet* would name runners those surfaces do not show.
   * → docs/spec/17-cockpit.md#the-validate-pane
   */
  standings?: Map<string, CheckStanding>;
  /**
   * Put a check's sheet row into the next press, or take it out. The goal page hands the sheet's own
   * route; the surfaces that draw the set without the runners hand nothing, and draw no boxes.
   */
  onSelect?: (environment: string, rowId: string, selected: boolean) => Promise<unknown> | unknown;
  look?: ButtonLook;
  onResult: (checkId: string, result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onWaive: (checkId: string, reason: string) => Promise<unknown> | unknown;
  onReset: (checkId: string) => Promise<unknown> | unknown;
  onHandover: (checkId: string, to: 'fleet' | 'human') => Promise<unknown> | unknown;
}

/**
 * The validation plan: how anyone checks the *goal* was met, and what anybody
 * concluded from running each check.
 *
 * **It is drawn on the goal page, not on the plan sheet.** The plan writes the
 * checks and amends them, so the sheet still renders them — as {@link
 * ValidationDigest}, read-only. But running one is not reading a plan: it is work
 * against the delivered goal, done days after the plan was approved and usually by
 * somebody who has no reason to open it. A control reachable only from inside the
 * document that proposed it is a control nobody finds. Defining and managing are
 * two jobs, and this component is the second one.
 *
 * **Every control writes an operator's reading and derives nothing.** The section
 * has no opinion about whether a check passed; there is no "mark all", and no
 * state is inferred from a merged part or a green build. That is the same refusal
 * the acceptance checklist makes, one layer up: a positive terminal inferred from
 * incidental evidence is a check nobody ran, recorded as one that passed.
 *
 * @public embedded by the goal page, which owns its card and its chrome
 */
export function ValidationSection({
  checks,
  plan,
  issueNumber,
  resources,
  refUrls,
  desktopFolder,
  standings,
  onSelect,
  look = { ghost: true, size: 'small' },
  onResult,
  onWaive,
  onReset,
  onHandover,
}: ValidationSectionProps) {
  useEffect(() => {
    logUsage('validation.view');
  }, []);
  const live = checks.filter((c) => c.supersededReason === null);
  const withdrawn = checks.filter((c) => c.supersededReason !== null);
  const byName = new Map(resources.map((r) => [r.name, r]));

  /* Which check the sheet is answering. Null is *the queue picks* — the first one still owed — and
     only an operator's own click pins it, so a reading recorded on the head of the queue advances to
     the next rather than leaving the operator on a check they have just finished. A pinned id that
     the set no longer holds falls back to the queue rather than drawing nothing. */
  const [focus, setFocus] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  /* Off the check just answered and onto the next one owed — by *releasing* the pin rather than
     moving it. With nothing pinned the queue already picks the first check still owed, and the check
     just answered is no longer one; a pin walked forward by hand would be a second mechanism saying
     the same thing, and the two would disagree the first time a reading came in from elsewhere. */
  const release = (): void => setFocus(null);

  if (checks.length === 0) return <EmptySet plan={plan} />;

  const block = (check: ValidationCheckView): JSX.Element => (
    <CheckBlock
      key={check.id}
      check={check}
      resources={check.uses.flatMap((name) => {
        const found = byName.get(name);
        return found ? [found] : [];
      })}
      refUrls={refUrls}
      look={look}
      issueNumber={issueNumber}
      desktopFolder={desktopFolder}
      onResult={async (result, note) => {
        await onResult(check.id, result, note);
        release();
      }}
      onWaive={(reason) => onWaive(check.id, reason)}
      onReset={() => onReset(check.id)}
      onHandover={(to) => onHandover(check.id, to)}
    />
  );

  /* The goal page's presentation: one flat list, banded by where each check's answer is coming
     from, nothing expanded until an operator opens a row. The queue below — a meter, one check
     open, the rest as lines — is what the needs band and the plan sheet still draw, where the set
     is read without the runners beside it. Two presentations of one set, because the two surfaces
     are asked different questions. → docs/spec/17-cockpit.md#the-validate-pane */
  if (standings !== undefined) {
    return (
      <BandedChecks
        live={live}
        withdrawn={withdrawn}
        plan={plan}
        resources={resources}
        standings={standings}
        opened={live.find((c) => c.id === focus) ?? null}
        onOpen={setFocus}
        onSelect={onSelect}
        block={block}
      />
    );
  }

  return (
    <CheckQueue
      live={live}
      withdrawn={withdrawn}
      plan={plan}
      resources={resources}
      focus={focus}
      all={all}
      onAll={() => setAll(!all)}
      onOpen={setFocus}
      block={block}
    />
  );
}

function BandedChecks({
  live,
  withdrawn,
  plan,
  resources,
  standings,
  opened,
  onOpen,
  onSelect,
  block,
}: {
  live: ValidationCheckView[];
  withdrawn: ValidationCheckView[];
  plan: ValidationPlanRecord | null;
  resources: ValidationResourceView[];
  standings: Map<string, CheckStanding>;
  opened: ValidationCheckView | null;
  onOpen: (checkId: string) => void;
  onSelect: ((environment: string, rowId: string, selected: boolean) => Promise<unknown> | unknown) | undefined;
  block: (check: ValidationCheckView) => JSX.Element;
}) {
  return (
    <>
      {plan?.authoredAt == null && (
        <p className="vq-band-note">
          Written before the code existed, so no check carries a test plan and no runner can take one. A fresh set is
          written against the delivered code.
        </p>
      )}
      {plan?.authoredAt != null && plan.releasedAt == null && (
        <p className="vq-band-note">Nothing in the fleet reads this set as work until you accept it in “Needs you”.</p>
      )}
      {ALL_BANDS.map((band) => {
        const inBand = live.filter((check) => standings.get(check.id)?.band === band);
        if (inBand.length === 0) return null;
        return (
          <div className="vq-band" key={band}>
            <span className="lb lb-sm">
              {BAND_HEADING[band]} <i className="vq-band-n">{inBand.length}</i>
              {/* Which runner, once on the heading rather than on every row under it: in a band
                  of five, five copies of “staging can take it” is the reading nobody needed
                  five times. → docs/spec/17-cockpit.md#the-validate-pane */}
              {band !== 'yours' && runners(inBand, standings) !== null && (
                <i className="vq-band-n"> · {runners(inBand, standings)}</i>
              )}
            </span>
            {inBand.map((check) =>
              opened?.id === check.id ? (
                block(check)
              ) : (
                <CheckLine
                  key={check.id}
                  check={check}
                  standing={standings.get(check.id)}
                  onOpen={() => onOpen(check.id)}
                  onSelect={onSelect}
                />
              ),
            )}
          </div>
        );
      })}
      {(plan?.note != null || resources.length > 0 || withdrawn.length > 0) && (
        <BandedAbout plan={plan} resources={resources} withdrawn={withdrawn} />
      )}
    </>
  );
}

function BandedAbout({
  plan,
  resources,
  withdrawn,
}: {
  plan: ValidationPlanRecord | null;
  resources: ValidationResourceView[];
  withdrawn: ValidationCheckView[];
}) {
  return (
    <details className="vq-about">
      <summary>About these checks</summary>
      {plan?.note != null && <div className="pm-vnote">{plan.note}</div>}
      {resources.length > 0 && (
        <div className="pm-vres">
          {resources.map((resource) => (
            <Tag key={resource.name} tone={isMissingFile(resource) ? 'amber' : undefined} title={resource.path}>
              {resource.name}
              {resource.kind !== null && <i className="k">{resource.kind}</i>}
              {isMissingFile(resource) && <i className="k">missing</i>}
            </Tag>
          ))}
        </div>
      )}
      {withdrawn.map((check) => (
        <WithdrawnRow key={check.id} check={check} />
      ))}
    </details>
  );
}

function CheckQueue({
  live,
  withdrawn,
  plan,
  resources,
  focus,
  all,
  onAll,
  onOpen,
  block,
}: {
  live: ValidationCheckView[];
  withdrawn: ValidationCheckView[];
  plan: ValidationPlanRecord | null;
  resources: ValidationResourceView[];
  focus: string | null;
  all: boolean;
  onAll: () => void;
  onOpen: (checkId: string) => void;
  block: (check: ValidationCheckView) => JSX.Element;
}) {
  const owed = live.filter(isOwed);
  const picked = live.find((c) => c.id === focus) ?? owed[0] ?? live[0];
  const shown = all ? live : picked === undefined ? [] : [picked];
  const rest = {
    owed: live.filter((c) => c !== picked && isOwed(c)),
    done: live.filter((c) => c !== picked && !isOwed(c)),
  };
  const line = (check: ValidationCheckView): JSX.Element => (
    <CheckLine key={check.id} check={check} standing={undefined} onOpen={() => onOpen(check.id)} onSelect={undefined} />
  );
  return (
    <>
      <QueueHead live={live} owed={owed} plan={plan} all={all} onAll={onAll} />
      {/* The planner's departure from the hint, and what the set needs to hand. Both were bands of
          their own above the rows; they are what a reader consults rather than reads, so they fold. */}
      {(plan?.note != null || resources.length > 0) && <QueueAbout plan={plan} resources={resources} />}
      {/* The work, one check at a time. Nine checks drawn open together is nine checks' worth of
          prose, chips and controls competing for one decision — and the decision is always about
          *one* of them. So the sheet leads with the check that is next and keeps the rest as a line
          each: the set stays visible and countable, and only the one being answered is loud.
          → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue */}
      {shown.map(block)}
      {/* Still to run, in the bands the pane's runner panels answer from: a run is on them, a press
          would take them, or nobody offered and they are a person's. One list of checks, banded by
          where its answers come from — never a second list per runner.
          → docs/spec/17-cockpit.md#the-validate-pane */}
      {!all && rest.owed.length > 0 && (
        <div className="vq-rest">
          <span className="lb lb-sm">Still to run</span>
          {rest.owed.map(line)}
        </div>
      )}
      {!all && rest.done.length > 0 && (
        <details className="vq-rest vq-done">
          <summary>{rest.done.length} done</summary>
          {rest.done.map(line)}
        </details>
      )}
      <WithdrawnList withdrawn={withdrawn} />
    </>
  );
}

function QueueHead({
  live,
  owed,
  plan,
  all,
  onAll,
}: {
  live: ValidationCheckView[];
  owed: ValidationCheckView[];
  plan: ValidationPlanRecord | null;
  all: boolean;
  onAll: () => void;
}) {
  const amended = live.filter((c) => c.amendedAt !== null);
  /* One line, not a stack of prose. What an operator needs before they start is *how much is
     left*, and it was being told to them in three paragraphs and two amber bands — which is the
     reading a card is least likely to be given. A meter is read without being read.
     → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue */
  return (
    <div className="vq-head">
      <span className="vq-count">
        {owed.length === 0 ? (
          <b>All {live.length} done</b>
        ) : (
          <>
            <b>{owed.length}</b> still to run<span className="muted"> of {live.length}</span>
          </>
        )}
      </span>
      <span className="vq-meter" aria-hidden>
        {live.map((c) => (
          <i key={c.id} className={`vq-pip ${c.state}`} />
        ))}
      </span>
      {plan?.authoredAt == null && (
        <Tag
          tone="amber"
          title="Written before the code existed, so no check carries a test plan and the fleet can run none of them. A fresh set is written against the delivered code."
        >
          written before the code
        </Tag>
      )}
      {plan?.authoredAt != null && plan.releasedAt == null && (
        <Tag tone="amber" title="Nothing in the fleet reads this set as work until you accept it in “Needs you”.">
          needs your OK
        </Tag>
      )}
      {amended.length > 0 && (
        <Tag tone="amber" title={`Reworded since the plan was written: ${amended.map((c) => c.letter).join(', ')}`}>
          {amended.length} changed
        </Tag>
      )}
      {/* The whole set at once, for the reader who wants the table rather than the queue. Off by
          default: it is the shape this surface used to have, and it is the wrong default for the
          job the surface is for. */}
      {live.length > 1 && (
        <Button ghost size="small" className="vq-all" onClick={onAll}>
          {all ? 'One at a time' : 'Show all'}
        </Button>
      )}
    </div>
  );
}

function QueueAbout({ plan, resources }: { plan: ValidationPlanRecord | null; resources: ValidationResourceView[] }) {
  return (
    <details className="vq-about">
      <summary>About these checks</summary>
      {plan?.note != null && <div className="pm-vnote">{plan.note}</div>}
      {resources.length > 0 && (
        <div className="pm-vres">
          {resources.map((resource) => (
            <Tag
              key={resource.name}
              tone={isMissingFile(resource) ? 'amber' : undefined}
              title={`${resource.path}${
                resource.note === null
                  ? ''
                  : `

${resource.note}`
              }`}
            >
              {resource.name}
              {resource.kind !== null && <i className="k">{resource.kind}</i>}
              {isMissingFile(resource) && <i className="k">missing</i>}
            </Tag>
          ))}
        </div>
      )}
    </details>
  );
}

function WithdrawnRow({ check }: { check: ValidationCheckView }) {
  return (
    <div className="pm-vrow gone">
      <span className="pm-vletter">{check.letter}</span>
      <div>
        <div className="pm-vtitle">{check.title}</div>
        <div className="muted small">{check.supersededReason}</div>
      </div>
    </div>
  );
}

function WithdrawnList({ withdrawn }: { withdrawn: ValidationCheckView[] }) {
  if (withdrawn.length === 0) return null;
  return (
    <details className="pm-vgone">
      <summary>
        {withdrawn.length} check{withdrawn.length === 1 ? '' : 's'} dropped when the checks changed
      </summary>
      {withdrawn.map((check) => (
        <WithdrawnRow key={check.id} check={check} />
      ))}
    </details>
  );
}

/**
 * The same checks, read-only, on the plan sheet that wrote them.
 *
 * A plan under review has to show what it proposes to check — that is part of
 * judging it — but the sheet is not where a reading is recorded any more, so it
 * offers no verb at all. What it draws instead is the way to the place that does.
 *
 * It shares this file with {@link ValidationSection} rather than sitting beside it,
 * because the two say the same things about a check — its letter, its state, its
 * wording, what an amendment withdrew — and the failure worth designing against is
 * the two drifting into describing one check differently on two surfaces.
 *
 * @public embedded by the plan sheet, where the checks are defined rather than run
 */
export function ValidationDigest({
  checks,
  plan,
  refUrls,
  onOpenGoal,
}: {
  checks: ValidationCheckView[];
  plan: ValidationPlanRecord | null;
  refUrls: Record<string, string>;
  onOpenGoal: (() => void) | null;
}) {
  const live = checks.filter((c) => c.supersededReason === null);
  const withdrawn = checks.filter((c) => c.supersededReason !== null);
  const settled = live.filter((c) => c.state === 'passed' || c.state === 'waived').length;

  if (checks.length === 0) return <EmptySet plan={plan} />;

  return (
    <>
      <span className="pm-section-label">
        Checks <i className="k">{live.length > 0 ? `${settled} of ${live.length} done` : 'withdrawn'}</i>
      </span>
      {live.map((check) => (
        <div className={`pm-vrow ${check.state}`} key={check.id}>
          <span className="pm-vletter">{check.letter}</span>
          <div>
            <div className="pm-vhead">
              <span className="pm-vtitle">{check.title}</span>
              <Tag tone={stateTone(check.state)}>{CHECK_STATE_WORDS[check.state]}</Tag>
              {check.covers.map((slug) => (
                <Tag key={slug} lower title="A part this check exercises">
                  {slug}
                </Tag>
              ))}
            </div>
            <CheckDetail
              doing={renderMarkdown(check.do, refUrls)}
              steps={check.steps}
              passesWhen={renderMarkdown(check.expect, refUrls)}
              proof={check.proof === null ? null : renderMarkdown(check.proof, refUrls)}
            />
          </div>
        </div>
      ))}
      <WithdrawnList withdrawn={withdrawn} />
      <div className="pm-vout">
        This plan proposes the checks. What anyone saw when they ran one is recorded on the goal.
        {onOpenGoal !== null && (
          <Button ghost size="small" onClick={onOpenGoal}>
            Open the goal →
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * The runners named by a band's checks, said once on its heading. Null where they do not agree —
 * two environments across one band is a fact about the rows and belongs on them, not on a heading
 * that would then be wrong for half of what is under it.
 */
function runners(checks: readonly ValidationCheckView[], standings: Map<string, CheckStanding>): string | null {
  const said = new Set(checks.map((check) => standings.get(check.id)?.label ?? ''));
  return said.size === 1 ? ([...said][0] ?? null) : null;
}

/** The order the owed bands are read in: what is moving, what could move, what is waiting on a person. */
const BANDS: CheckBand[] = ['running', 'open', 'yours'];

/** The same order with what is settled at the end, which is the whole list on the goal page. */
const ALL_BANDS: CheckBand[] = [...BANDS, 'answered'];

/** Work still owed. `passed` and `waived` are the two states that settle a check; everything else —
 *  unrun, captured, failed, deferred, declined — is something somebody still has to answer.
 *  → docs/spec/20-validation.md#states */
function isOwed(check: ValidationCheckView): boolean {
  return check.state !== 'passed' && check.state !== 'waived';
}
