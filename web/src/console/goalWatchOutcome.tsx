import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { WatchCheckVerdict, WatchOutcome, WatchOutcomeCheck } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { discussionPrompt } from '../cockpit/desktopLink.js';
import type { TagTone } from '../components/tag.js';

// → docs/spec/29-post-deploy-watch.md#the-outcome

const TONE: Record<WatchOutcome['outcome'], TagTone> = {
  worked: 'green',
  worse: 'red',
  unknown: 'amber',
  none: 'grey',
  unwritten: 'grey',
  watching: 'grey',
};

/** Which checks each answer draws, in order, and the words over each group after the first. */
const GROUPS: Record<'worked' | 'worse' | 'unknown', { verdict: WatchCheckVerdict; label: string | null }[]> = {
  worked: [{ verdict: 'clean', label: null }],
  worse: [
    { verdict: 'regressed', label: null },
    { verdict: 'clean', label: 'Still clean:' },
    { verdict: 'unknown', label: 'Not read:' },
  ],
  unknown: [
    { verdict: 'unknown', label: null },
    { verdict: 'clean', label: 'Read clean:' },
  ],
};

/**
 * The one answer the Watch pane opens on. Every check is still drawn on the cards below it: this
 * names what passed as well as what did not, and never folds an unread check into a pass.
 */
export function WatchOutcomeCard({
  outcome,
  ...acts
}: {
  outcome: WatchOutcome | null;
} & Omit<ActsProps, 'outcome'>): JSX.Element | null {
  if (outcome === null) return null;
  const answer = outcome.outcome;
  return (
    <section className={`cn-card cn-outcome cn-t-${TONE[answer]}`} id="cn-watch-outcome">
      <h3>
        {outcome.headline}
        {outcome.watching.length > 0 && answer !== 'watching' && (
          <span className="cn-more">still watching {outcome.watching.join(', ')}</span>
        )}
      </h3>
      {answer === 'watching' && (
        <p className="cn-sub">
          No window has settled yet, so there is no answer — {outcome.watching.join(', ')} is still being read.
        </p>
      )}
      {answer === 'none' && <p className="cn-sub">{outcome.reason}</p>}
      {answer === 'unwritten' && (
        <p className="cn-sub">Work has landed, and nobody has written what a running system should show for it yet.</p>
      )}
      {(answer === 'worked' || answer === 'worse' || answer === 'unknown') && (
        <>
          {GROUPS[answer].map(({ verdict, label }) => {
            const checks = outcome.checks.filter((c) => c.verdict === verdict);
            if (checks.length === 0) return null;
            return (
              <div key={verdict}>
                {label !== null && <p className="cn-sub">{label}</p>}
                <Numbers checks={checks} reasons={verdict !== 'clean'} />
              </div>
            );
          })}
          <Acts outcome={outcome} {...acts} />
        </>
      )}
    </section>
  );
}

interface ActsProps {
  outcome: WatchOutcome;
  issueNumber: number;
  /** `discussionsDir` is set; without it there is no Discuss button, not a disabled one. */
  discussions: boolean;
  desktopFolder: string;
  actions: CockpitActions;
}

function Acts({ outcome, issueNumber, discussions, desktopFolder, actions }: ActsProps): JSX.Element | null {
  const discussable = discussions && outcome.discussable;
  if (outcome.extendable.length === 0 && !discussable) return null;
  return (
    <div className="cn-outcome-acts">
      {outcome.extendable.map((environment) => (
        <AsyncButton
          key={environment}
          size="small"
          usage="watch.defer"
          onClick={() => actions.extendWatch(issueNumber, environment)}
          title={`Re-open ${environment}'s settled window and watch on from now. The readings it already took stay where they are.`}
        >
          extend {environment}
        </AsyncButton>
      ))}
      {discussable && (
        <DesktopLink
          folder={desktopFolder}
          prompt={discussionPrompt(issueNumber)}
          ready="ready to send"
          explain={`after writing these readings into #${String(issueNumber)}'s discussion as a note, to decide what they mean`}
          label="Discuss in Claude"
          usage="discussion.open"
          control={false}
          onOpen={() => actions.discussWatchOutcome(issueNumber)}
        />
      )}
    </div>
  );
}

function Numbers({ checks, reasons }: { checks: WatchOutcomeCheck[]; reasons: boolean }): JSX.Element {
  return (
    <ul className="cn-outcome-checks">
      {checks.map((c) => (
        <li key={c.checkId}>
          <b className="cn-name">{c.title}</b> <span className="cn-outcome-num">{numbers(c)}</span>
          {reasons && c.reason !== null && <span className="cn-sub">{c.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function numbers(check: WatchOutcomeCheck): string {
  if (check.after === null && check.before === null) return '';
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const rows = check.kind === 'signal' ? ' rows' : '';
  const show = (n: number | null): string => (n === null ? '?' : n.toLocaleString());
  const on = check.environment === null ? '' : ` on ${check.environment}`;
  const over = check.windowSpan === null ? '' : ` over ${check.windowSpan}`;
  const elsewhere =
    check.beforeEnvironment !== null && check.environment !== null && check.beforeEnvironment !== check.environment;
  const before = elsewhere
    ? `${show(check.before)} on ${check.beforeEnvironment} before the merge`
    : show(check.before);
  return `${before} → ${show(check.after)}${rows}${unit}${on}${over}`;
}
