import type { JSX } from 'react';
import type { ProposedCheck } from '../types.js';
import type { ProposedCheckSet } from '../checkSet.js';
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
export function CheckSetAsk({ set }: { set: ProposedCheckSet }): JSX.Element {
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
            <Row key={check.letter} check={check} />
          ))}
        </ul>
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

function Row({ check }: { check: ProposedCheck }): JSX.Element {
  return (
    <li className="vp-row">
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
      <div className="vp-flags">
        {check.carriesQuery && (
          <Tag tone="blue" title="This check reads the deployed store; its query is approved on its own dry run">
            query
          </Tag>
        )}
        {check.fleetBlocked ? (
          <Tag title="A person carries the first step, so this one can never be dispatched">yours</Tag>
        ) : (
          check.fleetCandidate && (
            <Tag tone="green" title="The planner thinks an agent could run this; handing it over is still yours">
              fleet?
            </Tag>
          )
        )}
      </div>
    </li>
  );
}
