import type { JSX } from 'react';
import { api } from '../api.js';
import { summarySection } from '../view/summarySection.js';
import type { FeatureRollup, FeatureSummary } from '../types.js';
import { AsyncButton } from './AsyncButton.js';

// → docs/spec/17-cockpit.md#the-feature-summary

/**
 * The summariser's account of a Feature, drawn one way for every surface that draws
 * it. It lives here rather than on either of them because both the board and focus
 * mode answer the same question with it, and while they each had their own copy they
 * answered it differently: focus drew the three fields as unlabelled paragraphs and
 * left the lede out altogether, so the mode meant for one Feature at a time was the
 * worse of the two at saying where that Feature is.
 */
export function FeatureAccount({ summary }: { summary: FeatureSummary | null }): JSX.Element | null {
  if (summary === null) return null;
  if (summary.usable === null && summary.blocked === null && summary.remaining === null) return null;
  return (
    <div className="cn-fb-summary">
      <AccountBlock title="Usable now" body={summary.usable} tone="usable" />
      <AccountBlock title="Needs a person" body={summary.blocked} tone="blocked" />
      <AccountBlock title="Left to do" body={summary.remaining} tone="remaining" />
    </div>
  );
}

function AccountBlock({
  title,
  body,
  tone,
}: {
  title: string;
  body: string | null;
  tone: 'blocked' | 'usable' | 'remaining';
}): JSX.Element | null {
  if (body === null) return null;
  const section = summarySection(body);
  return (
    <div className={`cn-fb-sum-block cn-fb-sum-${tone}`}>
      <h4>{title}</h4>
      {section.kind === 'prose' ? (
        <p>{section.text}</p>
      ) : (
        <ul>
          {section.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The two standing marks an operator sets on a Feature, together because that is how
 * the instruction arrives: told a Feature is now the priority, somebody flags it and
 * rests what can wait. → docs/spec/17-cockpit.md#the-two-standing-marks
 */
export function FeatureMarks({ feature, onChanged }: { feature: FeatureRollup; onChanged: () => void }): JSX.Element {
  const flagged = feature.priority !== null;
  const paused = feature.paused !== null;
  return (
    <>
      <AsyncButton
        size="small"
        ghost={!flagged}
        className="cn-fb-priority"
        aria-pressed={flagged}
        title={
          flagged
            ? 'The fleet works this Feature and everything under it first. Press to hand the queue back to its natural order.'
            : 'Work this Feature first: its stories, their parts and their pull requests go to the front of every queue they are in.'
        }
        onClick={async () => {
          await api.setGoalPriority(feature.number, !flagged);
          onChanged();
        }}
      >
        {flagged ? 'Priority' : 'Prioritise'}
      </AsyncButton>
      <AsyncButton
        size="small"
        ghost
        className="cn-fb-pause"
        aria-pressed={paused}
        title={
          paused
            ? 'Resume: work under this Feature is picked up again.'
            : 'Pause: no work under this Feature is picked up, and the card rests until you hover it.'
        }
        onClick={async () => {
          await api.setFeaturePaused(feature.number, !paused);
          onChanged();
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </AsyncButton>
    </>
  );
}
