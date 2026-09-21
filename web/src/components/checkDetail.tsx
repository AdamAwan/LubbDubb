import type { JSX, ReactNode } from 'react';
import type { ValidationCheckActor, ValidationCheckState, ValidationStep, ValidationStepKind } from '../types.js';

// → docs/spec/20-validation.md#the-check, docs/spec/17-cockpit.md

/**
 * A check's steps, in the one shape both surfaces can hand over. The proposal carries less than the
 * sheet does — no `when`, no `area`, no script — so the fields only a written check has are optional
 * rather than duplicated into a second type.
 */
interface CheckStepView {
  kind: ValidationStepKind;
  do: string;
  actor: ValidationCheckActor;
  why: string | null;
  when?: ValidationStep['when'];
  area?: string | null;
  script?: string | null;
  scriptSweptAt?: string | null;
}

/**
 * The words a check is described with, in one place because the failure worth designing against is
 * the two surfaces describing one check differently.
 *
 * A check is proposed on one card and run on another, days apart, and until this existed each surface
 * had grown its own vocabulary for the same three fields — *Do* against *(nothing)*, *Expect* against
 * *Passes when*, *Test plan* against an unlabelled list — with a reader left to work out that they
 * were looking at the same thing twice. → docs/spec/20-validation.md#the-check
 *
 */
/**
 * What each state is *called*, which is not what it is *stored as*. The stored vocabulary is the
 * domain's and stays where it is; these are the words an operator reads.
 *
 * Four of the seven were terms of art that only make sense from inside the harness. `unrun` is not a
 * word in English. `waived` is legal language for a decision an operator makes ten times a week.
 * `declined` and `waived` sat beside each other meaning two different things with no way to tell
 * which from the words. And `captured` — the one state that is *asking* for something — named the
 * mechanism that produced it rather than the thing it wants, which is somebody's eyes.
 * → docs/spec/20-validation.md#states
 *
 * @public the labels every surface draws a check's state through
 */
export const CHECK_STATE_WORDS: Record<ValidationCheckState, string> = {
  unrun: 'not run',
  passed: 'passed',
  failed: 'failed',
  deferred: 'later',
  waived: 'skipped',
  captured: 'needs a look',
  declined: 'dropped',
};

const CHECK_WORDS = {
  doing: 'Do',
  steps: 'Steps',
  passes: 'Passes when',
  proof: 'Proves it',
  fleet: 'the fleet',
  you: 'you',
  youAfter: 'you, afterwards',
  allFleet: 'every step is the fleet’s',
  allYours: 'every step is yours',
} as const;

/**
 * Who carries one step, in the one word each surface uses for it. `deferred` is the only distinction
 * worth a second word: a person's step *inside* the run stops it where it stands, and a person's step
 * afterwards does not. → docs/spec/20-validation.md#who-carries-a-step
 */
function stepWho(step: CheckStepView): string {
  if (step.actor === 'fleet') return CHECK_WORDS.fleet;
  return step.when === 'deferred' ? CHECK_WORDS.youAfter : CHECK_WORDS.you;
}

function StepList({ steps }: { steps: CheckStepView[] }): JSX.Element {
  /* Said once under the list rather than stamped on every row of it. A column of identical "the
     fleet" chips is the single loudest thing on a sheet and carries one bit of news; who carries a
     step only earns its own place on the row where it *differs*. */
  const actors = new Set(steps.map((s) => stepWho(s)));
  const uniform = actors.size === 1 ? [...actors][0] : null;
  return (
    <>
      <ol className="cd-steps">
        {steps.map((step, at) => (
          <li key={at}>
            <span className="cd-n">{at + 1}</span>
            <span className={`cd-kind${step.kind === 'state' ? ' cd-kind-query' : ''}`}>{step.kind}</span>
            <span className="cd-do">
              {step.do}
              {step.area != null && <i className="cd-area">{step.area}</i>}
              {step.script != null && (
                <span className="cd-script">
                  <i>a one-off script — written for this check, never reviewed, never committed</i>
                  <pre>{step.script}</pre>
                </span>
              )}
              {step.scriptSweptAt != null && (
                <i className="cd-area">its one-off script was removed on {step.scriptSweptAt.slice(0, 10)}</i>
              )}
            </span>
            {uniform === null && (
              <span className={`cd-who${step.actor === 'fleet' ? '' : ' cd-yours'}`} title={step.why ?? undefined}>
                {stepWho(step)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {uniform !== null && (
        <div className={`cd-uniform${uniform === CHECK_WORDS.fleet ? '' : ' cd-yours'}`}>
          {uniform === CHECK_WORDS.fleet ? CHECK_WORDS.allFleet : CHECK_WORDS.allYours}
        </div>
      )}
    </>
  );
}

/**
 * A check's body: what to do, the steps that do it, and what makes it a pass — as one label column
 * rather than three stacked blocks in three different shapes.
 *
 * **The labels are a column, not headings.** The two halves used to be a two-up grid with `DO` over
 * one and `EXPECT` over the other, and the steps a third block below with a heading of its own; on a
 * card of nine checks that is twenty-seven headings for three facts. Aligned down one gutter the
 * three read as one record, and the eye finds the same field in the same place on every row.
 *
 * `doing` and `passesWhen` arrive rendered because only one of the two surfaces resolves refs in
 * them, and a component that took the raw string would have to know which.
 *
 * @public drawn by `CheckSetAsk` and by `ValidationSection`'s row and digest
 */
export function CheckDetail({
  doing,
  steps,
  foldSteps = false,
  passesWhen,
  proof = null,
  meta,
}: {
  doing: ReactNode;
  steps: CheckStepView[];
  /**
   * Fold the steps away behind a disclosure. What a person needs in order to run the check is `doing`
   * and `passesWhen`; the steps are the machine-readable journey the fleet would carry, and drawn
   * open on every check they are the longest thing on the row for the reader least likely to want
   * them. The proposal card leaves them open — there they are most of what is being judged.
   */
  foldSteps?: boolean;
  passesWhen: ReactNode;
  /**
   * What a pass has to hand back, where the check's author demanded it. Null is *none demanded* and
   * draws nothing — the ordinary case, and the row must not grow a gutter label for it.
   * → docs/spec/20-validation.md#proof
   */
  proof?: ReactNode;
  meta?: ReactNode;
}): JSX.Element {
  return (
    <dl className="cd">
      {doing !== null && (
        <>
          <dt>{CHECK_WORDS.doing}</dt>
          <dd>{doing}</dd>
        </>
      )}
      {steps.length > 0 && !foldSteps && (
        <>
          <dt>{CHECK_WORDS.steps}</dt>
          <dd>
            <StepList steps={steps} />
          </dd>
        </>
      )}
      {passesWhen !== null && (
        <>
          <dt>{CHECK_WORDS.passes}</dt>
          <dd>{passesWhen}</dd>
        </>
      )}
      {proof !== null && proof !== undefined && (
        <>
          <dt>{CHECK_WORDS.proof}</dt>
          <dd>{proof}</dd>
        </>
      )}
      {steps.length > 0 && foldSteps && (
        <>
          <dt />
          <dd>
            <details className="cd-fold">
              <summary>
                {CHECK_WORDS.steps.toLowerCase()} the fleet would carry ({steps.length})
              </summary>
              <StepList steps={steps} />
            </details>
          </dd>
        </>
      )}
      {meta !== undefined && (
        <>
          <dt />
          <dd className="cd-meta">{meta}</dd>
        </>
      )}
    </dl>
  );
}
