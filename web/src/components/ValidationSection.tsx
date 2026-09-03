import { useState } from 'react';
import type { ValidationCheck, ValidationCheckState, ValidationResourceView } from '../types.js';
import { checkPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from './DesktopLink.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { Button, buttonClass } from './button.js';
import type { ButtonLook } from './button.js';
import { Tag, type TagTone } from './tag.js';

/**
 * Whether a resource's absence is worth drawing.
 *
 * `present` is the file fact — `existsSync` on the path the name resolves to
 * under the goal's validation directory — and for an `access` resource there was
 * never going to be a file: it names a login or an environment, which is a
 * precondition the check's own `do` carries. Warned about, it is a chip that says
 * "missing" on every draw for the life of the goal, and a sheet whose warnings
 * mean nothing is a sheet whose real one is not read.
 */
function isMissingFile(resource: ValidationResourceView): boolean {
  return !resource.present && resource.kind !== 'access';
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
  issueNumber,
  resources,
  refUrls,
  desktopFolder,
  look = { ghost: true, size: 'small' },
  onResult,
  onDefer,
  onWaive,
  onReset,
  onHandover,
}: {
  /** Superseded checks included — drawing what a plan withdrew is half the point. */
  checks: ValidationCheck[];
  /** The goal these checks hang off, for the desktop prompt's `<issue>:<letter>`. */
  issueNumber: number;
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  /** `config.desktopFolder` — the checkout the desktop hand-off opens Claude Code on. */
  desktopFolder: string;
  /**
   * The station's own button tone, the seam `HumanTaskActions` and
   * `EscalationCard` already take — [`Button`](./button.tsx)'s props rather than a
   * class string, so the caller cannot hand down a base class this section then
   * prefixes a second one onto. One component, two faces; the alternative is a
   * second wiring of five verbs, and five more places for the refusals to drift.
   */
  look?: ButtonLook;
  onResult: (checkId: string, result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onDefer: (checkId: string, reason: string) => Promise<unknown> | unknown;
  onWaive: (checkId: string, reason: string) => Promise<unknown> | unknown;
  onReset: (checkId: string) => Promise<unknown> | unknown;
  onHandover: (checkId: string, to: 'fleet' | 'human') => Promise<unknown> | unknown;
}) {
  const live = checks.filter((c) => c.supersededReason === null);
  const withdrawn = checks.filter((c) => c.supersededReason !== null);
  const settled = live.filter((c) => c.state === 'passed' || c.state === 'waived').length;
  const amended = live.filter((c) => c.amendedAt !== null);
  const byName = new Map(resources.map((r) => [r.name, r]));

  if (checks.length === 0) {
    return (
      // Said rather than hidden, the write-up section's rule: an absent section
      // reads as "there was nothing to check", which is indistinguishable from
      // "nobody wrote one" — and only one of those is a problem.
      <p className="empty">
        No validation plan. Nothing checks that this goal actually works beyond what the parts merged, so closing it is
        a judgement call rather than a verdict.
      </p>
    );
  }

  return (
    <>
      {/* One amber line, not two. The unsettled count and the amendment count were
          separate bands on the plan sheet; on a card this size they are the same
          sentence, and two stacked warnings only invite a reader to rank them.
          `unrun` sits inside the unsettled count on purpose: with every check a
          person's by default, the set nobody got to is the realistic failure. */}
      {(settled < live.length || amended.length > 0) && (
        <div className="pm-vflag">
          {live.length > settled && (
            <b>
              {live.length - settled} of {live.length} not settled
            </b>
          )}
          {live.length > settled && ' — closing this goal will ask you to say why. '}
          {/* Counted here as well as banded per row: a sheet of nine checks with
              one rewritten is exactly where a per-row band gets scrolled past, and
              this is the change an operator most needs not to miss. */}
          {amended.length > 0 && (
            <>
              {amended.length === 1 ? 'One check has' : `${amended.length} checks have`} changed since the plan was
              written — {amended.map((c) => c.letter).join(', ')}.
            </>
          )}
        </div>
      )}
      {resources.length > 0 && (
        <div className="pm-vres">
          {resources.map((resource) => (
            <Tag
              key={resource.name}
              tone={isMissingFile(resource) ? 'amber' : undefined}
              title={`${resource.path}${resource.note === null ? '' : `\n\n${resource.note}`}`}
            >
              {resource.name}
              {resource.kind !== null && <i className="k">{resource.kind}</i>}
              {isMissingFile(resource) && <i className="k">missing</i>}
            </Tag>
          ))}
        </div>
      )}
      {live.map((check) => (
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
          onResult={(result, note) => onResult(check.id, result, note)}
          onDefer={(reason) => onDefer(check.id, reason)}
          onWaive={(reason) => onWaive(check.id, reason)}
          onReset={() => onReset(check.id)}
          onHandover={(to) => onHandover(check.id, to)}
        />
      ))}
      {withdrawn.length > 0 && (
        <details className="pm-vgone">
          <summary>
            {withdrawn.length} check{withdrawn.length === 1 ? '' : 's'} an amended plan withdrew
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
  refUrls,
  onOpenGoal,
}: {
  checks: ValidationCheck[];
  refUrls: Record<string, string>;
  /** Null when the plan hangs off no goal — then there is nowhere to send anyone. */
  onOpenGoal: (() => void) | null;
}) {
  const live = checks.filter((c) => c.supersededReason === null);
  const withdrawn = checks.filter((c) => c.supersededReason !== null);
  const settled = live.filter((c) => c.state === 'passed' || c.state === 'waived').length;

  if (checks.length === 0) {
    return (
      <p className="empty">
        No validation plan. Nothing checks that this goal actually works beyond what the parts merged, so closing it is
        a judgement call rather than a verdict.
      </p>
    );
  }

  return (
    <>
      <span className="pm-section-label">
        Validation <i className="k">{live.length > 0 ? `${settled}/${live.length} settled` : 'withdrawn'}</i>
      </span>
      {live.map((check) => (
        <div className={`pm-vrow ${check.state}`} key={check.id}>
          <span className="pm-vletter">{check.letter}</span>
          <div>
            <div className="pm-vhead">
              <span className="pm-vtitle">{check.title}</span>
              <Tag tone={stateTone(check.state)}>{check.state}</Tag>
              {check.covers.map((slug) => (
                <Tag key={slug} lower title="A part this check exercises">
                  {slug}
                </Tag>
              ))}
            </div>
            <div className="pm-vbody">
              <div>
                <b>Do</b>
                {renderMarkdown(check.do, refUrls)}
              </div>
              <div>
                <b>Expect</b>
                {renderMarkdown(check.expect, refUrls)}
              </div>
            </div>
          </div>
        </div>
      ))}
      {withdrawn.length > 0 && (
        // The withdrawn checks stay on the sheet rather than moving with the
        // controls: what an amendment dropped is a fact about *this plan*, and the
        // goal's card lists what is still to be checked.
        <details className="pm-vgone">
          <summary>
            {withdrawn.length} check{withdrawn.length === 1 ? '' : 's'} an amended plan withdrew
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

/** Which verb an operator has open on a check, or none. */
type Verb = 'passed' | 'failed' | 'deferred' | 'waived';

const VERB_PROMPT: Record<Verb, string> = {
  passed: 'What did you see? (optional)',
  failed: 'What happened?',
  deferred: 'What is it waiting for?',
  waived: 'Why is this one not being checked?',
};

/**
 * One check, collapsed to its head until somebody opens it.
 *
 * Six checks at full height is most of a screen, and the card sits above the plan —
 * so the steps fold away and the head keeps what a glance is for: the letter, the
 * title, the state, and who is on it.
 *
 * **The bands draw whether the row is open or shut.** An amendment and a hand-back
 * are the two things a reader must not be able to scroll past without seeing, and a
 * collapsed row that hid them would do exactly that. Folding away the steps costs a
 * click; folding away "the check you already ran was rewritten" costs the reading.
 */
function CheckBlock({
  check,
  resources,
  refUrls,
  look,
  issueNumber,
  desktopFolder,
  onResult,
  onDefer,
  onWaive,
  onReset,
  onHandover,
}: {
  check: ValidationCheck;
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  look: ButtonLook;
  issueNumber: number;
  desktopFolder: string;
  onResult: (result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onDefer: (reason: string) => Promise<unknown> | unknown;
  onWaive: (reason: string) => Promise<unknown> | unknown;
  onReset: () => Promise<unknown> | unknown;
  onHandover: (to: 'fleet' | 'human') => Promise<unknown> | unknown;
}) {
  const [open, setOpen] = useState(false);
  const [verb, setVerb] = useState<Verb | null>(null);
  const [note, setNote] = useState('');
  const send = useAsyncAction();
  const promptText = checkPrompt(issueNumber, check.letter);

  const submit = (): void => {
    const text = note.trim();
    // The server refuses a blank note in the same words, for every verb but a
    // pass; refusing here saves the round trip and never instead of it.
    if (verb === null || (text.length === 0 && verb !== 'passed')) return;
    void send.run(async () => {
      if (verb === 'passed' || verb === 'failed') await onResult(verb, text);
      else if (verb === 'deferred') await onDefer(text);
      else await onWaive(text);
      setVerb(null);
      setNote('');
    });
  };

  return (
    <div className={`pm-vrow ${check.state}${open ? ' open' : ''}`}>
      {/* The letter, not the position: it is the handle that stays put across an
          amendment, so it is what a person writes down. */}
      <span className="pm-vletter">{check.letter}</span>
      <div>
        <button className="pm-vhead" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="pm-vtitle">{check.title}</span>
          <Tag lower>{check.id}</Tag>
          <Tag tone={stateTone(check.state)}>{check.state}</Tag>
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
              an agent could run this
            </Tag>
          )}
          {check.covers.map((slug) => (
            <Tag key={slug} lower title="A part this check exercises">
              {slug}
            </Tag>
          ))}
          <i className="pm-vcar" aria-hidden>
            ▸
          </i>
        </button>
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
        {open && (
          <>
            <div className="pm-vbody">
              <div>
                <b>Do</b>
                {renderMarkdown(check.do, refUrls)}
              </div>
              <div>
                <b>Expect</b>
                {renderMarkdown(check.expect, refUrls)}
              </div>
            </div>
            {resources.length > 0 && (
              <div className="pm-vres">
                {resources.map((resource) => (
                  <Tag key={resource.name} tone={isMissingFile(resource) ? 'amber' : undefined} title={resource.path}>
                    {resource.name}
                    {isMissingFile(resource) && <i className="k">missing</i>}
                  </Tag>
                ))}
              </div>
            )}
          </>
        )}
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
            {check.resultBy === 'agent' && <i className="k">recorded by an agent</i>}
            {/* Not "by an agent" and not silence: a desktop session is the
                operator's own Claude, which reached an environment the fleet
                cannot and still did not carry the steps out by hand. Silence is
                reserved for a person, because that is what a checklist already
                means. */}
            {check.resultBy === 'desktop' && <i className="k">recorded from a desktop session</i>}
            {check.deferUntil !== null && <i className="k">until {check.deferUntil}</i>}
          </div>
        )}
        {open &&
          (verb === null ? (
            <div className="pm-vacts">
              {check.state === 'unrun' ? (
                <>
                  <Button {...look} onClick={() => setVerb('passed')}>
                    Passed
                  </Button>
                  <Button {...look} onClick={() => setVerb('failed')}>
                    Failed
                  </Button>
                  <Button {...look} onClick={() => setVerb('deferred')}>
                    Defer
                  </Button>
                  <Button {...look} onClick={() => setVerb('waived')}>
                    Waive
                  </Button>
                  {/* The hand-over, beside the four readings and deliberately not
                      among them: it says who runs the check, not what it said. It
                      is offered on every unrun check rather than only on a
                      nominated one — the planner's nomination is an argument, and
                      an operator who knows their own deployment does not need the
                      planner's permission to use it. */}
                  {check.actor === 'fleet' ? (
                    <AsyncButton
                      {...look}
                      title="Stop waiting for an agent and take this check back"
                      onClick={() => onHandover('human')}
                    >
                      Take it back
                    </AsyncButton>
                  ) : (
                    <AsyncButton
                      {...look}
                      title="Let the harness put an agent on this check once the goal is delivered"
                      onClick={() => onHandover('fleet')}
                    >
                      Hand to the fleet
                    </AsyncButton>
                  )}
                  {/* The third runner, and the only one the cockpit cannot start
                      itself: a desktop session claims a check from the operator's
                      own Claude Code. So this hands the check *over* — the deep
                      link opens that client on this repository with the command
                      already typed, which is a destination and therefore an
                      anchor. `DesktopLink` keeps the command in the title,
                      because a link that silently did nothing and a command
                      nobody can read are the same dead end — and only the machine
                      running this browser has a client to answer it. */}
                  <DesktopLink
                    className={buttonClass(look)}
                    folder={desktopFolder}
                    prompt={promptText}
                    explain="so this check runs at the keyboard — with the browser and the logins the fleet has not — and reports the reading back here."
                  >
                    Run it in Claude Code
                  </DesktopLink>
                </>
              ) : (
                // One way back from every settled state, and it takes no note for a
                // dismissal's reason: it says nothing about the work, only that what
                // was recorded no longer holds.
                <AsyncButton {...look} title="Withdraw what was recorded and put it back to unrun" onClick={onReset}>
                  Back to unrun
                </AsyncButton>
              )}
            </div>
          ) : (
            <form
              className="pm-vsay"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                autoFocus
                placeholder={VERB_PROMPT[verb]}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setVerb(null);
                }}
              />
              <SubmitButton phase={send.phase} tone="primary" size="small">
                {verb === 'deferred' ? 'Defer' : verb === 'waived' ? 'Waive' : verb === 'passed' ? 'Passed' : 'Failed'}
              </SubmitButton>
              <Button {...look} onClick={() => setVerb(null)}>
                Cancel
              </Button>
            </form>
          ))}
      </div>
    </div>
  );
}

/**
 * What an amendment changed, drawn above the check it changed.
 *
 * **This is the whole of "you are told when the plan changes".** A validation plan
 * is written by the one agent that has not done the work yet, so it has to be
 * correctable — and a check that can be quietly rewritten under an operator who
 * already ran it is worse than one that cannot change at all: they would go on
 * believing they had checked something the plan no longer asks for. So the band is
 * loud, it says what the check used to say, and it says what the change cost.
 *
 * It clears itself when the operator records a reading against the new wording,
 * which is the only acknowledgement worth having — a dismiss button would clear it
 * for somebody who had merely seen it.
 */
function AmendBand({ check, refUrls }: { check: ValidationCheck; refUrls: Record<string, string> }) {
  const prior = check.revision;
  return (
    <div className="pm-vamend">
      <div className="pm-vamend-head">
        {prior === null ? (
          // No prior wording: this check was *added* after the plan was read. Not
          // a withdrawal of anything, and saying "amended" would imply one.
          <b>Added by an amendment</b>
        ) : prior.state === null ? (
          <b>Reworded by an amendment</b>
        ) : (
          // The case the band exists for, stated in the operator's own terms: they
          // did the work, and it no longer counts for the check as it now reads.
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
            <div className="pm-vbody">
              <div>
                <b>Do</b>
                {renderMarkdown(prior.do, refUrls)}
              </div>
              <div>
                <b>Expect</b>
                {renderMarkdown(prior.expect, refUrls)}
              </div>
            </div>
            {prior.note !== null && <div className="pm-vnote">{prior.note}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

/** The tag's tone. `deferred` is deliberately not green: it is a check still owed. */
function stateTone(state: ValidationCheckState): TagTone | undefined {
  if (state === 'passed') return 'green';
  if (state === 'failed') return 'red';
  if (state === 'unrun' || state === 'deferred') return 'amber';
  return undefined;
}
