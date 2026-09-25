import { CaveatChecklist } from './CaveatChecklist.js';
import { renderMarkdown } from './markdown.js';
import { logUsage } from '../cockpit/usage.js';
import { JumpSection, type Derived, type PlanModalProps } from './planModalShared.js';

export function CaveatsSection({
  plan,
  caveatAnswers,
  refUrls,
  decidable,
  caveats,
  ack,
  sections,
}: PlanModalProps & Derived) {
  return (
    <JumpSection at="caveats" sections={sections} className="pm-flags">
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
    </JumpSection>
  );
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
