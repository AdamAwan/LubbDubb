import { useState } from 'react';
import type { ValidationCheck, ValidationCheckState, ValidationResourceView } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';

/**
 * The validation plan on the plan sheet: how anyone checks the *goal* was met,
 * and what anybody concluded from running each check.
 *
 * A section rather than a tab, for the sheet's own reason — a tab is a thing you
 * have to know to click — and it sits after the parts because the reading order
 * is answer, then work, then how anyone knows it worked.
 *
 * **Every control writes an operator's reading and derives nothing.** The section
 * has no opinion about whether a check passed; there is no "mark all", and no
 * state is inferred from a merged part or a green build. That is the same refusal
 * the acceptance checklist above it makes, one layer up: a positive terminal
 * inferred from incidental evidence is a check nobody ran, recorded as one that
 * passed.
 */
export function ValidationSection({
  checks,
  resources,
  refUrls,
  onResult,
  onDefer,
  onWaive,
  onReset,
}: {
  /** Superseded checks included — drawing what a plan withdrew is half the point. */
  checks: ValidationCheck[];
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  onResult: (checkId: string, result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onDefer: (checkId: string, reason: string) => Promise<unknown> | unknown;
  onWaive: (checkId: string, reason: string) => Promise<unknown> | unknown;
  onReset: (checkId: string) => Promise<unknown> | unknown;
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
      <span className="pm-section-label">
        Validation <i className="k">{live.length > 0 ? `${settled}/${live.length} settled` : 'withdrawn'}</i>
      </span>
      {/* The flag, stated once at the top rather than left to be counted off the
          rows. `unrun` sits beside `failed` on purpose: with every check a
          person's by default, the set nobody got to is the realistic failure. */}
      {live.length > 0 && settled < live.length && (
        <div className="pm-vflag">
          {live.length - settled} of {live.length} not settled — closing this goal will ask you to say why.
        </div>
      )}
      {/* The amendments, counted once at the top as well as banded per row: a
          sheet of nine checks with one rewritten is exactly where a per-row band
          gets scrolled past, and this is the change an operator most needs not to
          miss. */}
      {amended.length > 0 && (
        <div className="pm-vamend">
          {amended.length === 1 ? 'One check has' : `${amended.length} checks have`} changed since the plan was written
          — {amended.map((c) => c.letter).join(', ')}.
        </div>
      )}
      {resources.length > 0 && (
        <div className="pm-vres">
          {resources.map((resource) => (
            <span
              key={resource.name}
              className={`chip small${resource.present ? '' : ' warn'}`}
              title={`${resource.path}${resource.note === null ? '' : `\n\n${resource.note}`}`}
            >
              {resource.name}
              {resource.kind !== null && <i className="k">{resource.kind}</i>}
              {!resource.present && <i className="k">missing</i>}
            </span>
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
          onResult={(result, note) => onResult(check.id, result, note)}
          onDefer={(reason) => onDefer(check.id, reason)}
          onWaive={(reason) => onWaive(check.id, reason)}
          onReset={() => onReset(check.id)}
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

/** Which verb an operator has open on a check, or none. */
type Verb = 'passed' | 'failed' | 'deferred' | 'waived';

const VERB_PROMPT: Record<Verb, string> = {
  passed: 'What did you see?',
  failed: 'What happened?',
  deferred: 'What is it waiting for?',
  waived: 'Why is this one not being checked?',
};

function CheckBlock({
  check,
  resources,
  refUrls,
  onResult,
  onDefer,
  onWaive,
  onReset,
}: {
  check: ValidationCheck;
  resources: ValidationResourceView[];
  refUrls: Record<string, string>;
  onResult: (result: 'passed' | 'failed', note: string) => Promise<unknown> | unknown;
  onDefer: (reason: string) => Promise<unknown> | unknown;
  onWaive: (reason: string) => Promise<unknown> | unknown;
  onReset: () => Promise<unknown> | unknown;
}) {
  const [verb, setVerb] = useState<Verb | null>(null);
  const [note, setNote] = useState('');
  const send = useAsyncAction();

  const submit = (): void => {
    const text = note.trim();
    // The server refuses a blank note in the same words; refusing here saves the
    // round trip and never instead of it.
    if (verb === null || text.length === 0) return;
    void send.run(async () => {
      if (verb === 'passed' || verb === 'failed') await onResult(verb, text);
      else if (verb === 'deferred') await onDefer(text);
      else await onWaive(text);
      setVerb(null);
      setNote('');
    });
  };

  return (
    <div className={`pm-vrow ${check.state}`}>
      {/* The letter, not the position: it is the handle that stays put across an
          amendment, so it is what a person writes down. */}
      <span className="pm-vletter">{check.letter}</span>
      <div>
        <div className="pm-vhead">
          <span className="pm-vtitle">{check.title}</span>
          <span className="chip small mono">{check.id}</span>
          <span className={`chip small${stateTone(check.state)}`}>{check.state}</span>
          {check.fleetCandidate && (
            <span className="chip small" title={check.candidateWhy ?? 'The planner thinks an agent could run this'}>
              an agent could run this
            </span>
          )}
          {check.covers.map((slug) => (
            <span key={slug} className="chip small mono" title="A part this check exercises">
              {slug}
            </span>
          ))}
        </div>
        {check.amendedAt !== null && <AmendBand check={check} refUrls={refUrls} />}
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
              <span
                key={resource.name}
                className={`chip small${resource.present ? '' : ' warn'}`}
                title={resource.path}
              >
                {resource.name}
                {!resource.present && <i className="k">missing</i>}
              </span>
            ))}
          </div>
        )}
        {check.resultNote !== null && (
          <div className="pm-vnote">
            {check.resultNote}
            {check.deferUntil !== null && <i className="k">until {check.deferUntil}</i>}
          </div>
        )}
        {verb === null ? (
          <div className="pm-vacts">
            {check.state === 'unrun' ? (
              <>
                <button className="btn ghost small" onClick={() => setVerb('passed')}>
                  Passed
                </button>
                <button className="btn ghost small" onClick={() => setVerb('failed')}>
                  Failed
                </button>
                <button className="btn ghost small" onClick={() => setVerb('deferred')}>
                  Defer
                </button>
                <button className="btn ghost small" onClick={() => setVerb('waived')}>
                  Waive
                </button>
              </>
            ) : (
              // One way back from every settled state, and it takes no note for a
              // dismissal's reason: it says nothing about the work, only that what
              // was recorded no longer holds.
              <AsyncButton
                className="ghost small"
                title="Withdraw what was recorded and put it back to unrun"
                onClick={onReset}
              >
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
            <SubmitButton phase={send.phase} className="primary small">
              {verb === 'deferred' ? 'Defer' : verb === 'waived' ? 'Waive' : verb === 'passed' ? 'Passed' : 'Failed'}
            </SubmitButton>
            <button type="button" className="btn ghost small" onClick={() => setVerb(null)}>
              Cancel
            </button>
          </form>
        )}
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

/** The chip's tone. `deferred` is deliberately not `ok`: it is a check still owed. */
function stateTone(state: ValidationCheckState): string {
  if (state === 'passed') return ' ok';
  if (state === 'failed') return ' bad';
  if (state === 'unrun' || state === 'deferred') return ' warn';
  return '';
}
