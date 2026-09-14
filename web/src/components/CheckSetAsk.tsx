import { useState, type JSX } from 'react';
import type { CheckDecline, ProposedCheck } from '../types.js';
import type { ProposedCheckSet } from '../checkSet.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

/**
 * The check set as the operator meets it: one row per check, its journey under it, and who each step
 * falls to on the right.
 *
 * **Drawn as structure rather than prose**, which is the whole of why it exists. The set reached this
 * card as markdown first — the planner's note, then every check as a heading and two paragraphs — and
 * a set of any size read as one column of text with no way to compare two checks, find the one a
 * person has to carry, or see which reads the store. A verdict is being asked for on the *set*, so the
 * set has to be scannable.
 *
 * @public drawn by `EscalationCard` for a `validation_plan` proposal
 */
export function CheckSetAsk({ set, declines }: { set: ProposedCheckSet; declines?: CheckDeclines }): JSX.Element {
  const queries = set.checks.filter((c) => c.carriesQuery).map((c) => c.letter);
  return (
    <div className="vp-ask">
      {set.note !== null && (
        <p className="vp-note">
          <span className="lb lb-sm">What the planner says</span>
          {set.note}
        </p>
      )}
      {set.hint !== null && (
        <p className="vp-hint">
          <span className="lb lb-sm">What the plan asked for</span>
          {set.hint}
        </p>
      )}
      {set.checks.length === 0 ? (
        <p className="vp-empty">
          The planner declared no checks. Accepting agrees that nothing here needs running; rejecting asks for the set
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
          Every check is declined, so this is a rejection: the set goes back to be written again, and your reasons go
          with it.
        </p>
      )}
      {queries.length > 0 && (
        <p className="vp-queries">
          <b>{queries.join(', ')}</b> read the deployed store. Accepting does not approve the query each reads it with —
          you read that beside what it returns, on its own dry run, per environment.
        </p>
      )}
    </div>
  );
}

function Row({ check, declines }: { check: ProposedCheck; declines?: CheckDeclines }): JSX.Element {
  const struck = declines?.reasons[check.letter];
  return (
    <li className={`vp-row${struck === undefined ? '' : ' vp-struck'}`}>
      <span className="vp-letter">{check.letter}</span>
      <div className="vp-body">
        <div className="vp-title">{check.title}</div>
        {check.steps.length > 0 && (
          <ol className="vp-steps">
            {check.steps.map((step, at) => (
              <li key={`${check.letter}-${at}`}>
                <span className={`vp-kind${step.kind === 'state' ? ' vp-kind-state' : ''}`}>{step.kind}</span>
                <span className="vp-do">{step.do}</span>
                <span className={`vp-who${step.actor === 'fleet' ? ' vp-fleet' : ''}`}>
                  {step.actor === 'fleet' ? 'fleet' : 'you'}
                </span>
              </li>
            ))}
          </ol>
        )}
        {check.expect !== '' && (
          <div className="vp-expect">
            <span className="lb lb-sm">Passes when</span>
            {check.expect}
          </div>
        )}
        {/* The planner's nomination and the fact that stops it are the two things an operator needs
            before they hand anything over, and neither is a step. */}
        {check.fleetBlocked ? (
          <div className="vp-said">Its first step is a person’s, so the fleet cannot start this one.</div>
        ) : (
          check.fleetCandidate && (
            <div className="vp-said">
              The planner nominates the fleet{check.candidateWhy === null ? '' : `: ${check.candidateWhy}`}
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
              title="Strike this one check out of the set — the rest release, and no planner is asked again"
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
              <Button
                size="small"
                ghost
                title="Put this check back into the set"
                onClick={() => declines.keep(check.letter)}
              >
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
          <Tag tone="amber" title="This check reads the deployed store; its query is approved on its own dry run">
            query
          </Tag>
        )}
        {check.fleetBlocked && (
          <Tag title="A person carries the first step, so this one can never be dispatched">yours</Tag>
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
