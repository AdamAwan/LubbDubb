import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalWatchView, WatchCheckVerdict, WatchOutcome, WatchOutcomeCheck } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Icon } from '../components/icons.js';

// → docs/spec/29-post-deploy-watch.md#the-outcome

const HEADLINE: Record<WatchOutcome['outcome'], string> = {
  worked: 'It worked',
  worse: 'It made something worse',
  unknown: 'Couldn’t tell',
  none: 'Nothing was measured',
  watching: 'Watching',
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
  windows,
  issueNumber,
  discussions,
  desktopFolder,
  actions,
}: {
  outcome: WatchOutcome | null;
  windows: GoalWatchView[];
  issueNumber: number;
  /** `discussionsDir` is set; without it there is no Discuss button, not a disabled one. */
  discussions: boolean;
  desktopFolder: string;
  actions: CockpitActions;
}): JSX.Element | null {
  if (outcome === null) return null;
  const answer = outcome.outcome;
  return (
    <section className={`cn-card cn-outcome ${answer}`} id="cn-watch-outcome">
      <h3>
        {HEADLINE[answer]}
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
          <Acts
            outcome={outcome}
            windows={windows}
            issueNumber={issueNumber}
            discussions={discussions}
            desktopFolder={desktopFolder}
            actions={actions}
          />
        </>
      )}
    </section>
  );
}

function Acts({
  outcome,
  windows,
  issueNumber,
  discussions,
  desktopFolder,
  actions,
}: {
  outcome: WatchOutcome;
  windows: GoalWatchView[];
  issueNumber: number;
  discussions: boolean;
  desktopFolder: string;
  actions: CockpitActions;
}): JSX.Element | null {
  const extendable = outcome.outcome === 'unknown' ? windows.filter((w) => w.settledAt !== null) : [];
  const discussable = discussions && (outcome.outcome === 'worse' || outcome.outcome === 'unknown');
  if (extendable.length === 0 && !discussable) return null;
  const n = String(issueNumber);
  return (
    <div className="cn-outcome-acts">
      {extendable.map((w) => (
        <AsyncButton
          key={w.environment}
          size="small"
          usage="watch.defer"
          onClick={() => actions.extendWatch(issueNumber, w.environment)}
          title={`Re-open ${w.environment}'s settled window and watch on from now. The readings it already took stay where they are.`}
        >
          extend {w.environment}
        </AsyncButton>
      ))}
      {discussable && (
        <AsyncButton
          size="small"
          usage="discussion.open"
          onClick={() => actions.discussWatchOutcome(issueNumber, desktopFolder)}
          title={`Writes these readings into #${n}'s discussion as a note, then opens "/lubbdubb:discuss ${n}" in your own Claude Code to decide what they mean`}
        >
          <Icon name="chat" />
          Discuss in Claude ↗
        </AsyncButton>
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
  const over = check.windowHours === null ? '' : ` over ${String(check.windowHours)}h`;
  return `${show(check.before)} → ${show(check.after)}${rows}${unit}${on}${over}`;
}
