import { useEffect, useState } from 'react';
import type {
  ValidationCheck,
  ValidationCheckState,
  ValidationCheckView,
  ValidationPlanRecord,
  ValidationResourceView,
} from '../types.js';
import { checkPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from './DesktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import { Button } from './button.js';
import type { ButtonLook } from './button.js';
import { Tag, type TagTone } from './tag.js';
import { CheckDetail, CHECK_STATE_WORDS } from './checkDetail.js';
import { BAND_HEADING, type CheckBand, type CheckStanding } from '../view/validatePane.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

function isMissingFile(resource: ValidationResourceView): boolean {
  return !resource.present && resource.kind !== 'access';
}

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
}: {
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
}) {
  useEffect(() => {
    logUsage('validation.view');
  }, []);
  const live = checks.filter((c) => c.supersededReason === null);
  const withdrawn = checks.filter((c) => c.supersededReason !== null);
  const amended = live.filter((c) => c.amendedAt !== null);
  const byName = new Map(resources.map((r) => [r.name, r]));
  const owed = live.filter(isOwed);

  /* Which check the sheet is answering. Null is *the queue picks* — the first one still owed — and
     only an operator's own click pins it, so a reading recorded on the head of the queue advances to
     the next rather than leaving the operator on a check they have just finished. A pinned id that
     the set no longer holds falls back to the queue rather than drawing nothing. */
  const [focus, setFocus] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const picked = live.find((c) => c.id === focus) ?? owed[0] ?? live[0];
  const shown = all ? live : picked === undefined ? [] : [picked];
  const rest = {
    owed: live.filter((c) => c !== picked && isOwed(c)),
    done: live.filter((c) => c !== picked && !isOwed(c)),
  };
  /* Off the check just answered and onto the next one owed — by *releasing* the pin rather than
     moving it. With nothing pinned the queue already picks the first check still owed, and the check
     just answered is no longer one; a pin walked forward by hand would be a second mechanism saying
     the same thing, and the two would disagree the first time a reading came in from elsewhere. */
  const release = (): void => setFocus(null);

  if (checks.length === 0) return <EmptySet plan={plan} />;

  /* The goal page's presentation: one flat list, banded by where each check's answer is coming
     from, nothing expanded until an operator opens a row. The queue below — a meter, one check
     open, the rest as lines — is what the needs band and the plan sheet still draw, where the set
     is read without the runners beside it. Two presentations of one set, because the two surfaces
     are asked different questions. → docs/spec/17-cockpit.md#the-validate-pane */
  if (standings !== undefined) {
    const opened = live.find((c) => c.id === focus) ?? null;
    return (
      <>
        {plan?.authoredAt == null && (
          <p className="vq-band-note">
            Written before the code existed, so no check carries a test plan and no runner can take one. A fresh set is
            written against the delivered code.
          </p>
        )}
        {plan?.authoredAt != null && plan.releasedAt == null && (
          <p className="vq-band-note">
            Nothing in the fleet reads this set as work until you accept it in “Needs you”.
          </p>
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
                ) : (
                  <CheckLine
                    key={check.id}
                    check={check}
                    standing={standings.get(check.id)}
                    onOpen={() => setFocus(check.id)}
                    onSelect={onSelect}
                  />
                ),
              )}
            </div>
          );
        })}
        {(plan?.note != null || resources.length > 0 || withdrawn.length > 0) && (
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
              <div key={check.id} className="pm-vrow gone">
                <span className="pm-vletter">{check.letter}</span>
                <div>
                  <div className="pm-vtitle">{check.title}</div>
                  <div className="muted small">{check.supersededReason}</div>
                </div>
              </div>
            ))}
          </details>
        )}
      </>
    );
  }

  return (
    <>
      {/* One line, not a stack of prose. What an operator needs before they start is *how much is
          left*, and it was being told to them in three paragraphs and two amber bands — which is the
          reading a card is least likely to be given. A meter is read without being read.
          → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue */}
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
          <Button ghost size="small" className="vq-all" onClick={() => setAll(!all)}>
            {all ? 'One at a time' : 'Show all'}
          </Button>
        )}
      </div>
      {/* The planner's departure from the hint, and what the set needs to hand. Both were bands of
          their own above the rows; they are what a reader consults rather than reads, so they fold. */}
      {(plan?.note != null || resources.length > 0) && (
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
      )}
      {/* The work, one check at a time. Nine checks drawn open together is nine checks' worth of
          prose, chips and controls competing for one decision — and the decision is always about
          *one* of them. So the sheet leads with the check that is next and keeps the rest as a line
          each: the set stays visible and countable, and only the one being answered is loud.
          → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue */}
      {shown.map((check) => (
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
      ))}
      {/* Still to run, in the bands the pane's runner panels answer from: a run is on them, a press
          would take them, or nobody offered and they are a person's. One list of checks, banded by
          where its answers come from — never a second list per runner.
          → docs/spec/17-cockpit.md#the-validate-pane */}
      {!all && rest.owed.length > 0 && (
        <div className="vq-rest">
          <span className="lb lb-sm">Still to run</span>
          {rest.owed.map((check) => (
            <CheckLine
              key={check.id}
              check={check}
              standing={undefined}
              onOpen={() => setFocus(check.id)}
              onSelect={undefined}
            />
          ))}
        </div>
      )}
      {!all && rest.done.length > 0 && (
        <details className="vq-rest vq-done">
          <summary>{rest.done.length} done</summary>
          {rest.done.map((check) => (
            <CheckLine
              key={check.id}
              check={check}
              standing={undefined}
              onOpen={() => setFocus(check.id)}
              onSelect={undefined}
            />
          ))}
        </details>
      )}
      {withdrawn.length > 0 && (
        <details className="pm-vgone">
          <summary>
            {withdrawn.length} check{withdrawn.length === 1 ? '' : 's'} dropped when the checks changed
          </summary>
          {withdrawn.map((check) => (
            <div key={check.id} className="pm-vrow gone">
              <span className="pm-vletter">{check.letter}</span>
              <div>
                <div className="pm-vtitle">{check.title}</div>
                <div className="muted small">{check.supersededReason}</div>
              </div>
            </div>
          ))}
        </details>
      )}
    </>
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
            />
          </div>
        </div>
      ))}
      {withdrawn.length > 0 && (
        <details className="pm-vgone">
          <summary>
            {withdrawn.length} check{withdrawn.length === 1 ? '' : 's'} dropped when the checks changed
          </summary>
          {withdrawn.map((check) => (
            <div key={check.id} className="pm-vrow gone">
              <span className="pm-vletter">{check.letter}</span>
              <div>
                <div className="pm-vtitle">{check.title}</div>
                <div className="muted small">{check.supersededReason}</div>
              </div>
            </div>
          ))}
        </details>
      )}
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

/** Work still owed. `passed` and `waived` are the two states that settle a check; everything else —
 *  unrun, captured, failed, deferred, declined — is something somebody still has to answer.
 *  → docs/spec/20-validation.md#states */
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

function isOwed(check: ValidationCheckView): boolean {
  return check.state !== 'passed' && check.state !== 'waived';
}

/**
 * A check the sheet is not currently answering: one line, and a way to make it the one it is.
 *
 * It carries the letter, the title and the state and nothing else. The set has to stay countable —
 * an operator needs to see that there are four left and what they are about — and none of the rest
 * of a check helps with that. → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue
 */
/**
 * What a band already implies about the state of a check in it. A row that says it again is a chip
 * carrying no news, and a list of twelve of them is twelve boxes of shouting between the reader and
 * the two rows that are actually odd. → docs/spec/17-cockpit.md#the-validate-pane
 */
const BAND_IMPLIES: Record<CheckBand, ValidationCheckState | null> = {
  running: null,
  open: 'unrun',
  yours: 'unrun',
  answered: 'passed',
};

/**
 * A check the sheet is not currently answering: one line, and a way to make it the one it is.
 *
 * It carries the letter, the title and the state and nothing else. The set has to stay countable —
 * an operator needs to see that there are four left and what they are about — and none of the rest
 * of a check helps with that. → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue
 *
 * **Banded, it says less.** The queue draws chips because its lines sit under one heading and have
 * to carry their own state; a banded line sits under a heading that already said where its answer is
 * coming from, so the state is drawn only where it is *not* what the band implies, and everything it
 * draws is quiet text rather than a bordered chip. All of it is on the row at full weight the moment
 * it is opened.
 */
function CheckLine({
  check,
  standing,
  onOpen,
  onSelect,
}: {
  check: ValidationCheckView;
  standing: CheckStanding | undefined;
  onOpen: () => void;
  onSelect: ((environment: string, rowId: string, selected: boolean) => Promise<unknown> | unknown) | undefined;
}): JSX.Element {
  const aside =
    check.amendedAt !== null
      ? 'changed'
      : check.handbackNote !== null
        ? 'back with you'
        : check.actor === 'fleet'
          ? 'with the fleet'
          : null;
  if (standing !== undefined) {
    const odd = BAND_IMPLIES[standing.band] === check.state ? null : CHECK_STATE_WORDS[check.state];
    const row = standing.row;
    return (
      <div className={`vq-line ${check.state}`}>
        {/* The sheet's own `selected`, drawn where the checks are read and written back through the
            sheet's own route: what a press will carry has one answer, not a cockpit's and a
            store's. A row a run is already on is settled, so its box is not a question.
            → docs/spec/17-cockpit.md#which-checks-a-press-will-carry */}
        {row !== null && onSelect !== undefined ? (
          <input
            type="checkbox"
            className="vq-box"
            checked={row.selected}
            disabled={row.live}
            aria-label={`Carry “${check.title}” in ${row.environment}’s next run`}
            title={
              row.live
                ? `A run on ${row.environment} is carrying it now`
                : row.awaitingApproval
                  ? `In ${row.environment}’s next run — but its query needs approving before a press can read it`
                  : row.selected
                    ? `In ${row.environment}’s next run. Untick to leave it out — you will answer it another way`
                    : `Left out of ${row.environment}’s next run. Tick to put it back`
            }
            onChange={(e) => void onSelect(row.environment, row.rowId, e.target.checked)}
          />
        ) : (
          <span className="vq-box-none" aria-hidden />
        )}
        <button className="vq-line-open" onClick={onOpen}>
          <span className="pm-vletter">{check.letter}</span>
          <span className="vq-line-title">{check.title}</span>
          {aside !== null && <span className="vq-said">{aside}</span>}
          {odd !== null && <span className={`vq-said ${check.state}`}>{odd}</span>}
        </button>
      </div>
    );
  }
  return (
    <button className={`vq-line ${check.state}`} onClick={onOpen}>
      <span className="pm-vletter">{check.letter}</span>
      <span className="vq-line-title">{check.title}</span>
      {aside !== null && <Tag tone="amber">{aside}</Tag>}
      <Tag tone={stateTone(check.state)}>{CHECK_STATE_WORDS[check.state]}</Tag>
    </button>
  );
}

function CheckBlock({
  check,
  resources,
  refUrls,
  look,
  issueNumber,
  desktopFolder,
  onResult,
  onWaive,
  onReset,
  onHandover,
}: {
  check: ValidationCheckView;
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  look: ButtonLook;
  issueNumber: number;
  desktopFolder: string;
  onResult: (result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onWaive: (reason: string) => Promise<unknown> | unknown;
  onReset: () => Promise<unknown> | unknown;
  onHandover: (to: 'fleet' | 'human') => Promise<unknown> | unknown;
}) {
  const promptText = checkPrompt(issueNumber, check.letter);

  return (
    <div className={`pm-vrow open ${check.state}`}>
      {/* The letter, not the position: it is the handle that stays put across an
          amendment, so it is what a person writes down. */}
      <span className="pm-vletter">{check.letter}</span>
      <div>
        {/* A heading, not a control. The row used to fold away behind it, back when the sheet drew
            every check at once and had to; the sheet now draws one, so the click that opened this
            one is a click that did nothing an operator asked for. */}
        <div className="pm-vhead">
          <span className="pm-vtitle">{check.title}</span>
          {/* Only what a reader must weigh before they open the row. The check's own id and the parts
              it covers identify it rather than rank it, and drawn here they take the same weight as
              its state — six chips wrapping to a second line, of which one was the news. They are on
              the body's meta line instead, where a reader who wants the handle can read it.
              → docs/spec/17-cockpit.md */}
          <Tag tone={stateTone(check.state)}>{CHECK_STATE_WORDS[check.state]}</Tag>
          {/* The operator's own decision, drawn ahead of the planner's suggestion
              about it — one is what will happen, the other is an argument. */}
          {check.actor === 'fleet' && (
            <Tag tone="amber" title="You handed this to the fleet; an agent will run it">
              with the fleet
            </Tag>
          )}
          {/* Somebody is running this *now*, which is a different fact from who
              is expected to and is drawn ahead of both. Only a **live** claim
              reaches here — the server projects the row through `claimIsLive` —
              so this chip and the fleet list's keyboard entry appear and go
              together, and neither outlives what the rule reads. */}
          {check.claimedBy !== null && (
            <Tag
              tone="amber"
              title={`Claimed by a desktop session at ${check.claimedAt ?? 'an unknown time'} — the fleet will not run it while this stands, and it is drawn in the fleet list too`}
            >
              running at {check.claimedBy}
            </Tag>
          )}
          {check.fleetCandidate && check.actor !== 'fleet' && (
            <Tag title={check.candidateWhy ?? 'The planner thinks an agent could run this — you decide'}>
              the fleet could run this
            </Tag>
          )}
        </div>
        {check.amendedAt !== null && <AmendBand check={check} refUrls={refUrls} />}
        {/* The fleet tried and could not. Drawn as loudly as an amendment because
            it is the same kind of news — this check is not going to happen unless
            you do it — and because the reason is usually the one sentence that
            says what a person can do that an agent could not. */}
        {check.handbackNote !== null && (
          <div className="pm-vback">
            <b>Back with you</b> <span className="muted">{check.handbackNote}</span>
          </div>
        )}
        <CheckDetail
          doing={renderMarkdown(check.do, refUrls)}
          steps={check.steps}
          foldSteps
          passesWhen={renderMarkdown(check.expect, refUrls)}
          meta={
            <>
              <span className="cd-id">{check.id}</span>
              {check.covers.map((slug) => (
                <span key={slug} title="A part this check exercises">
                  {slug}
                </span>
              ))}
              {resources.map((resource) => (
                <span
                  key={resource.name}
                  className={isMissingFile(resource) ? 'cd-missing' : undefined}
                  title={resource.path}
                >
                  {resource.name}
                  {isMissingFile(resource) && ' — missing'}
                </span>
              ))}
            </>
          }
        />
        {/* The reading stays on the closed row. It is the answer to the question
            the row asks, and a state chip without the sentence behind it is the
            half a reader cannot act on. */}
        {check.resultNote !== null && (
          <div className="pm-vnote">
            {check.resultNote}
            {/* Who took the reading, beside the reading. "An agent says this
                passed" and "I ran it and it passed" are different facts, and the
                second must never be read off the first — which is the whole of
                what this feature is for, one level down. */}
            {/* One word for two dispatches, deliberately: the fleet running the
                check's own steps, and the fleet driving the browser on a
                validation sheet. Both are an agent unattended and neither was
                reviewed, which is the fact an operator counting green rows
                needs — where it happened is on the reading, beside the
                transcript. → docs/spec/36-remote-validation.md#a-check-the-agent-drives-itself */}
            {check.resultBy === 'agent' && (
              <i className="k" title="The fleet, unattended — nothing reviewed what it did">
                recorded by an agent
              </i>
            )}
            {/* Not "by an agent" and not silence: a desktop session is the
                operator's own Claude, which reached an environment the fleet
                cannot and still did not carry the steps out by hand. Silence is
                reserved for a person, because that is what a checklist already
                means. */}
            {check.resultBy === 'desktop' && <i className="k">recorded from a desktop session</i>}
            {/* The two machine readings are drawn apart, and that is the whole
                point of keeping the attribution: a reviewed spec is repository
                code that a pull request's reviewer read, and a one-off script is
                a throwaway nobody read. An operator counting green rows would
                otherwise be told they are the same evidence. */}
            {check.resultBy === 'spec' && <i className="k">recorded by the project’s own browser suite</i>}
            {check.resultBy === 'script' && (
              <i
                className="k"
                title="A one-off script, written for this check alone and never reviewed. Its source is in the test plan."
              >
                recorded by a one-off script — unreviewed
              </i>
            )}
            {check.deferUntil !== null && <i className="k">until {check.deferUntil}</i>}
          </div>
        )}
        {/* The screen itself, on the row. A `captured` check asks for one thing —
            somebody's eyes — and a state chip that only says the word would make
            an operator go and find the image before they could answer it. It is
            held with the goal's validation directory rather than swept with the
            run, because the whole point is that it outlives the run that took it.
            → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at */}
        {check.captureUrl !== null && (
          <div className="pm-vcap">
            <a href={check.captureUrl} target="_blank" rel="noreferrer" title="Open the full capture">
              <img src={check.captureUrl} alt={`The screen captured for check ${check.letter}`} />
            </a>
          </div>
        )}
        <div className="pm-vacts">
          {check.state === 'unrun' || check.state === 'captured' ? (
            <>
              {/* One press to record a reading. The row used to answer a click with a text field and a
                  second press — compulsory on a failure — on the argument that a bare result means
                  nothing in a month. In practice the field went untyped or unread, so what it bought
                  was not a record but a toll on the commonest act in the cockpit. What makes a bare
                  reading safe is that it is reversible and attributed: the row says who recorded it,
                  and `Undo` puts it back. A pass is the expected answer and goes on one click; the
                  two that are awkward to undo arm first, through the same double-press every
                  destructive control in the cockpit uses. → docs/spec/17-cockpit.md#the-button */}
              <AsyncButton {...look} tone="primary" onClick={() => onResult('passed', '')}>
                Passed
              </AsyncButton>
              <ConfirmButton
                label="Failed"
                confirmLabel="Confirm failed"
                ghost
                size="small"
                title="Record that this check did not pass"
                onConfirm={() => onResult('failed', '')}
              />
              <details className="pm-velse">
                <summary>Can’t run it now</summary>
                <div className="pm-velse-body">
                  {/* Deferral is gone. It recorded *I will come back to this*, which is what leaving a
                      check unrun already says — and it bought a second amber state, a second reason
                      field and a row in the queue that read as answered when nothing had been. */}
                  <ConfirmButton
                    label="Skip it"
                    confirmLabel="Confirm skip"
                    ghost
                    size="small"
                    title="This one does not need running — it settles without a reading"
                    onConfirm={() => onWaive('')}
                  />
                  {/* The hand-over. It says who runs the check, not what it said, so it is not among
                      the readings — and it is offered on every check rather than only a nominated one,
                      because the planner's nomination is an argument and an operator who knows their
                      own deployment does not need its permission. */}
                  {check.actor === 'fleet' ? (
                    <AsyncButton
                      ghost
                      size="small"
                      title="Stop waiting for an agent and take this check back"
                      onClick={() => onHandover('human')}
                    >
                      Take it back
                    </AsyncButton>
                  ) : (
                    <AsyncButton
                      ghost
                      size="small"
                      title="Let the harness put an agent on this check once the goal is delivered"
                      onClick={() => onHandover('fleet')}
                    >
                      Hand to the fleet
                    </AsyncButton>
                  )}
                  {/* The third runner, and the only one the cockpit cannot start itself: a desktop
                      session claims a check from the operator's own Claude Code. The deep link opens
                      that client on this repository with the command already typed, which is a
                      destination and therefore an anchor. */}
                  <DesktopLink
                    folder={desktopFolder}
                    prompt={promptText}
                    explain="so this check runs at the keyboard — with the browser and the logins the fleet has not — and reports the reading back here."
                  />
                </div>
              </details>
            </>
          ) : (
            <AsyncButton
              {...look}
              title="Withdraw what was recorded and put this check back to not run"
              onClick={() => {
                logUsage('validation.undo');
                return onReset();
              }}
            >
              Undo
            </AsyncButton>
          )}
        </div>
      </div>
    </div>
  );
}

function AmendBand({ check, refUrls }: { check: ValidationCheck; refUrls: Record<string, string> }) {
  const prior = check.revision;
  return (
    <div className="pm-vamend">
      <div className="pm-vamend-head">
        {prior === null ? (
          <b>Added by an amendment</b>
        ) : prior.state === null ? (
          <b>Reworded by an amendment</b>
        ) : (
          <b>
            Reworded after you recorded <i>{prior.state}</i> — that reading was withdrawn
          </b>
        )}
        {check.amendNote !== null && <span className="muted"> {check.amendNote}</span>}
      </div>
      {prior !== null && (
        <details>
          <summary>What it used to say</summary>
          <div className="pm-vamend-prior">
            <div className="pm-vtitle">{prior.title}</div>
            <CheckDetail
              doing={renderMarkdown(prior.do, refUrls)}
              steps={[]}
              passesWhen={renderMarkdown(prior.expect, refUrls)}
            />
            {prior.note !== null && <div className="pm-vnote">{prior.note}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

function stateTone(state: ValidationCheckState): TagTone | undefined {
  if (state === 'passed') return 'green';
  if (state === 'failed') return 'red';
  if (state === 'unrun' || state === 'deferred') return 'amber';
  // Its own hue, and not folded into either neighbour: amber would say *nobody has
  // started*, which is wrong — the work is done and the screen is here — and green
  // would say it passed, which is the one thing a capture never gets to claim.
  if (state === 'captured') return 'captured';
  // Its own hue beside `waived`'s default grey, because the two are different acts and an operator
  // reading the row a month later is entitled to know which one it was: a waiver says *this does not
  // need running*, a decline says *I did not accept this row into the set*.
  // → docs/spec/20-validation.md#declining-a-single-row
  if (state === 'declined') return 'violet';
  return undefined;
}
