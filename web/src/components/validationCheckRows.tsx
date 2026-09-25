import type { JSX } from 'react';
import type { ValidationCheck, ValidationCheckState, ValidationCheckView, ValidationResourceView } from '../types.js';
import type { CheckBand, CheckStanding } from '../view/validatePane.js';
import { checkPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from './DesktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { renderMarkdown } from './markdown.js';
import type { ButtonLook } from './button.js';
import { Tag, type TagTone } from './tag.js';
import { CheckDetail, CHECK_STATE_WORDS } from './checkDetail.js';
import { logUsage } from '../cockpit/usage.js';

export function isMissingFile(resource: ValidationResourceView): boolean {
  return !resource.present && resource.kind !== 'access';
}

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
export function CheckLine({
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

interface CheckAnswers {
  look: ButtonLook;
  desktopFolder: string;
  onResult: (result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onWaive: (reason: string) => Promise<unknown> | unknown;
  onReset: () => Promise<unknown> | unknown;
  onHandover: (to: 'fleet' | 'human') => Promise<unknown> | unknown;
}

export function CheckBlock({
  check,
  resources,
  refUrls,
  issueNumber,
  ...answers
}: CheckAnswers & {
  check: ValidationCheckView;
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  issueNumber: number;
}) {
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
          <CheckTags check={check} />
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
          proof={check.proof === null ? null : renderMarkdown(check.proof, refUrls)}
          meta={<CheckMeta check={check} resources={resources} />}
        />
        {/* The reading stays on the closed row. It is the answer to the question
            the row asks, and a state chip without the sentence behind it is the
            half a reader cannot act on. */}
        {check.resultNote !== null && <ReadingNote check={check} note={check.resultNote} />}
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
        <CheckActions check={check} promptText={checkPrompt(issueNumber, check.letter)} {...answers} />
      </div>
    </div>
  );
}

function CheckMeta({ check, resources }: { check: ValidationCheckView; resources: ValidationResourceView[] }) {
  return (
    <>
      <span className="cd-id">{check.id}</span>
      {check.covers.map((slug) => (
        <span key={slug} title="A part this check exercises">
          {slug}
        </span>
      ))}
      {resources.map((resource) => (
        <span key={resource.name} className={isMissingFile(resource) ? 'cd-missing' : undefined} title={resource.path}>
          {resource.name}
          {isMissingFile(resource) && ' — missing'}
        </span>
      ))}
    </>
  );
}

function CheckTags({ check }: { check: ValidationCheckView }) {
  return (
    <>
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
    </>
  );
}

function ReadingNote({ check, note }: { check: ValidationCheckView; note: string }) {
  return (
    <div className="pm-vnote">
      {note}
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
  );
}

function CheckActions({
  check,
  look,
  promptText,
  desktopFolder,
  onResult,
  onWaive,
  onHandover,
  onReset,
}: CheckAnswers & { check: ValidationCheckView; promptText: string }) {
  return (
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
          <CantRunNow
            check={check}
            promptText={promptText}
            desktopFolder={desktopFolder}
            onWaive={onWaive}
            onHandover={onHandover}
          />
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
  );
}

function CantRunNow({
  check,
  promptText,
  desktopFolder,
  onWaive,
  onHandover,
}: Pick<CheckAnswers, 'desktopFolder' | 'onWaive' | 'onHandover'> & {
  check: ValidationCheckView;
  promptText: string;
}) {
  return (
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
              proof={prior.proof === null ? null : renderMarkdown(prior.proof, refUrls)}
            />
            {prior.note !== null && <div className="pm-vnote">{prior.note}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

export function stateTone(state: ValidationCheckState): TagTone | undefined {
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
