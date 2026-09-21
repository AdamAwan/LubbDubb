import { useState, type JSX } from 'react';
import type { CheckDecline, ProposedCheck } from '../types.js';
import type { ProposedCheckSet } from '../checkSet.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import { CheckDetail } from './checkDetail.js';
import { renderMarkdown } from './markdown.js';

// → docs/spec/17-cockpit.md

/**
 * The check set as the operator meets it: one row per check, its journey under it, and who each step
 * falls to on the right.
 *
 * **Drawn as structure rather than prose**, which is the whole of why it exists. The set reached this
 * card as markdown first — the planner's note, then every check as a heading and two paragraphs — and
 * a set of any size read as one column of text with no way to compare two checks, find the one a
 * person has to carry, or see which reads live data. A verdict is being asked for on the *set*, so the
 * set has to be scannable.
 *
 * **The two fields that stay the planner's own words — its `note` and each check's `expect` — draw
 * through `renderMarkdown`.** Both are asked for as grouped bullets, and drawn as a raw string the
 * markers are what an operator reads: a paragraph of literal `- ` and `**` that is harder to scan
 * than the prose the bullets replaced.
 *
 * @public drawn by `EscalationCard` for a `validation_plan` proposal
 */
export function CheckSetAsk({ set, declines }: { set: ProposedCheckSet; declines?: CheckDeclines }): JSX.Element {
  const queries = set.checks.filter((c) => c.carriesQuery).map((c) => c.letter);
  return (
    <div className="vp-ask">
      {set.note !== null && (
        <div className="vp-note vp-prose">
          <span className="lb lb-sm">What the planner says</span>
          {renderMarkdown(set.note)}
        </div>
      )}
      {set.hint !== null && (
        <p className="vp-hint">
          <span className="lb lb-sm">What the plan asked for</span>
          {set.hint}
        </p>
      )}
      {set.checks.length === 0 ? (
        <p className="vp-empty">
          The planner declared no checks. Accepting agrees that nothing here needs running; rejecting asks for them
          again.
        </p>
      ) : (
        <ul className="vp-rows">
          {set.checks.map((check) => (
            <Row key={check.letter} check={check} declines={declines} />
          ))}
        </ul>
      )}
      {declines !== undefined && declines.whole && (
        <p className="vp-whole">
          You have struck out every check, so this is a rejection: they go back to be written again, and your reasons go
          with them.
        </p>
      )}
      {queries.length > 0 && (
        <p className="vp-queries">
          <b>{queries.join(', ')}</b> read live data from the deployment. Accepting does not approve the query each
          reads it with — you read that beside what it returns, on its own dry run, per environment.
        </p>
      )}
    </div>
  );
}

/** Who carries the steps, in the same words the step list uses. */
function carriedBy(check: ProposedCheck): string {
  const fleet = check.steps.filter((s) => s.actor === 'fleet').length;
  if (fleet === check.steps.length) return 'the fleet';
  if (fleet === 0) return 'yours';
  return 'part yours';
}

function Row({ check, declines }: { check: ProposedCheck; declines?: CheckDeclines }): JSX.Element {
  const struck = declines?.reasons[check.letter];
  return (
    <li className={`vp-row${struck === undefined ? '' : ' vp-struck'}`}>
      <span className="vp-letter">{check.letter}</span>
      <div className="vp-body">
        <div className="vp-title">{check.title}</div>
        {/* The same body the sheet draws, from the same component. A check is proposed here and run
            there, days apart, and the two had grown separate vocabularies for one record — which
            reads as two different things to the one person who meets both.
            → docs/spec/20-validation.md#the-check */}
        <details className="vp-open">
          <summary>
            {/* What the row is judged on, in one line: how long it is, who would carry it, and
                whether it reads live data. A set is accepted or sent back whole, so what the
                card owes a reader first is all of it at once — and every check drawn open is four
                lines each before the first comparison can be made.
                → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work */}
            <span className="vp-gist">
              {check.steps.length === 0
                ? 'no steps'
                : `${check.steps.length} ${check.steps.length === 1 ? 'step' : 'steps'}`}
              {check.steps.length > 0 && ` · ${check.fleetBlocked ? 'yours to start' : carriedBy(check)}`}
            </span>
          </summary>
          <CheckDetail
            doing={null}
            steps={check.steps}
            passesWhen={check.expect === '' ? null : renderMarkdown(check.expect)}
            proof={check.proof === '' ? null : renderMarkdown(check.proof)}
          />
        </details>
        {/* The planner's nomination and the fact that stops it are the two things an operator needs
            before they hand anything over, and neither is a step. */}
        {check.fleetBlocked ? (
          <div className="vp-said">Its first step is a person’s, so the fleet cannot start this one.</div>
        ) : (
          check.fleetCandidate && (
            <div className="vp-said">
              The planner says the fleet could run this{check.candidateWhy === null ? '' : `: ${check.candidateWhy}`}
            </div>
          )
        )}
      </div>
      {/* The brake, on the row it applies to. Whole-set reject is too blunt to be one: using it
          costs the operator the rows they were happy with, which is why an expensive row gets
          accepted instead of struck. → docs/spec/20-validation.md#declining-a-single-row */}
      {declines !== undefined && (
        <div className="vp-decline">
          {struck === undefined ? (
            <Button
              size="small"
              ghost
              title="Drop this one check — the rest go ahead, and no planner is asked again"
              onClick={() => declines.decline(check.letter)}
            >
              Decline
            </Button>
          ) : (
            <>
              <input
                className="vp-why"
                autoFocus
                placeholder="Why this one is not worth running — required"
                value={struck}
                onChange={(e) => declines.say(check.letter, e.target.value)}
              />
              <Button size="small" ghost title="Put this check back" onClick={() => declines.keep(check.letter)}>
                Keep it
              </Button>
            </>
          )}
        </div>
      )}
      {/* Only what the steps beside them do *not* already say. A chip repeating the
          actor of every step is a second reading of the same fact, stranded at the
          far edge of a wide card; the nomination has its own line under the steps. */}
      <div className="vp-flags">
        {check.carriesQuery && (
          <Tag
            tone="amber"
            title="This check reads live data from the deployment; the query it uses is approved separately, on its own dry run"
          >
            reads live data
          </Tag>
        )}
        {check.fleetBlocked && (
          <Tag title="A person carries the first step, so the fleet can never start this one">yours to start</Tag>
        )}
      </div>
    </li>
  );
}

interface CheckDeclines {
  /** The words typed against each struck letter, empty string included — an untyped reason is not sent. */
  reasons: Readonly<Record<string, string>>;
  decline: (letter: string) => void;
  keep: (letter: string) => void;
  say: (letter: string, reason: string) => void;
  /** What rides on the accept: only the rows carrying a reason. */
  declined: CheckDecline[];
  /** A struck row with nothing typed against it. The accept is held on this. */
  unsaid: string[];
  /** Every row in the set is struck, so the press is a rejection rather than an accept. */
  whole: boolean;
}

/**
 * The operator's declines, held here rather than on the card, so the same state reaches the rows that
 * draw the control and the button that sends them. Nothing is sent until a reason is typed: the route
 * refuses a reasonless decline, and a control that let the click through would put that refusal in
 * front of somebody who had no way to see it coming.
 *
 * @public the seam `EscalationCard` holds a `validation_plan`'s per-row verdicts on
 */
export function useCheckDeclines(set: ProposedCheckSet | null): CheckDeclines {
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const letters = set?.checks.map((c) => c.letter) ?? [];
  // Only the letters still in the set. A row superseded while the card was open leaves its words
  // behind, and sending them would name a check the operator is no longer looking at.
  const live = Object.entries(reasons).filter(([letter]) => letters.includes(letter));
  const declined = live.flatMap(([letter, reason]) =>
    reason.trim() === '' ? [] : [{ letter, reason: reason.trim() }],
  );
  return {
    reasons,
    decline: (letter) => setReasons((prev) => ({ ...prev, [letter]: '' })),
    keep: (letter) =>
      setReasons((prev) => {
        const next = { ...prev };
        delete next[letter];
        return next;
      }),
    say: (letter, reason) => setReasons((prev) => ({ ...prev, [letter]: reason })),
    declined,
    unsaid: live.filter(([, reason]) => reason.trim() === '').map(([letter]) => letter),
    whole: letters.length > 0 && declined.length === letters.length,
  };
}
