import { useMemo, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { CockpitView } from '../view/viewModel.js';
import type { NeedRow } from '../view/needsYou.js';
import { errorProblems, problemHandled, type ErrorProblem } from '../view/appErrors.js';
import { BareButton, Button } from '../components/button.js';
import { ErrorProblemItem } from '../components/ErrorProblem.js';
import { Icon } from '../components/icons.js';
import { Tag } from '../components/tag.js';
import { useAppErrors } from '../components/useAppErrors.js';
import { tabUsage } from '../cockpit/usage.js';
import { familyOf } from '../view/askFamilies.js';
import { plural } from '../view/plural.js';

// → docs/spec/17-cockpit.md#something-wrong-on-the-goal, docs/spec/39-app-errors.md#on-the-goal

/**
 * What is not working on this goal's environments: its declared watch checks that read regressed, and the
 * moved errors put on it. Errors are fetched only where some environment reads them.
 */
export function GoalProblems({
  goalRef,
  view,
  actions,
}: {
  goalRef: string;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const watches = view.needsYou.filter((row) => familyOf(row.kind) === 'wrong' && row.goalRef === goalRef);
  return view.state.config.appErrors ? (
    <WithErrors goalRef={goalRef} watches={watches} actions={actions} />
  ) : (
    <ProblemStrip watches={watches} problems={[]} onPressed={() => undefined} actions={actions} />
  );
}

function WithErrors({
  goalRef,
  watches,
  actions,
}: {
  goalRef: string;
  watches: NeedRow[];
  actions: CockpitActions;
}): JSX.Element | null {
  const { reading, reload } = useAppErrors();
  const problems = useMemo(() => (reading === null ? [] : errorProblems(reading, goalRef)), [reading, goalRef]);
  return <ProblemStrip watches={watches} problems={problems} onPressed={reload} actions={actions} />;
}

function problemsSaid(n: number, where: readonly string[]): string {
  return `${plural(n, 'problem')}${where.length > 0 ? ` on ${where.join(', ')}` : ''}`;
}

/** @public the seam the strip is rendered through in `test/appErrorsCockpit.test.ts` */
export function ProblemStrip({
  watches,
  problems,
  onPressed,
  actions,
}: {
  watches: readonly NeedRow[];
  problems: readonly ErrorProblem[];
  onPressed: () => void;
  actions: CockpitActions;
}): JSX.Element | null {
  const total = watches.length + problems.length;
  if (total === 0) return null;
  const open = problems.filter((p) => !problemHandled(p));
  const owed = watches.length + open.length;
  const whereOf = (ps: readonly ErrorProblem[]): string[] => [...new Set(ps.map((p) => p.environment))];
  if (owed === 0)
    return (
      <div className="cn-gprob cn-gprob-calm">
        <Icon name="check" size={14} />
        <span>{problemsSaid(total, whereOf(problems))}, all handled</span>
      </div>
    );
  const guessesOnly = watches.length === 0 && open.every((p) => p.basis === 'guess');
  return (
    <section className={`cn-gprob${guessesOnly ? ' cn-gprob-guess' : ''}`} aria-label="Something's wrong">
      <div className="cn-gprob-head">
        <Icon name="alert" size={14} />
        <b>{problemsSaid(owed, whereOf(open))} since this arrived</b>
        {total > owed && <span className="cn-gprob-handled">· {total - owed} handled</span>}
        <BareButton usage={tabUsage('needs')} className="cn-gprob-open" onClick={() => actions.openTab('needs')}>
          Open in Needs you
        </BareButton>
      </div>
      {watches.map((row) => (
        <div key={row.id} className="cn-prob cn-prob-row">
          <span className="cn-prob-tags">
            <Tag tone="red" lower>
              check failed
            </Tag>
          </span>
          <span className="cn-prob-what">
            <span className="cn-prob-title">{row.summary ?? row.title}</span>
          </span>
          <span className="cn-prob-acts">
            <Button
              size="small"
              usage={{ counted: 'escalation.view' }}
              onClick={() => actions.openPanel({ ask: row.id })}
            >
              Raise bug or settle
            </Button>
          </span>
        </div>
      ))}
      {problems.map((p) => (
        <ErrorProblemItem
          key={`${p.environment}/${p.key}`}
          problem={p}
          compact
          onPressed={onPressed}
          actions={actions}
        />
      ))}
    </section>
  );
}
