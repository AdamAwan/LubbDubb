import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { Button } from '../components/button.js';
import { useAppErrors } from '../components/useAppErrors.js';
import { goalErrorLines, HOW_SAID, type GoalErrorLine } from '../view/appErrors.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

/** Read only where some environment declares `errors`; the caller decides that. */
export function GoalErrors({ goalRef, actions }: { goalRef: string; actions: CockpitActions }): JSX.Element | null {
  const { reading } = useAppErrors();
  if (reading === null) return null;
  return <GoalErrorBadge lines={goalErrorLines(reading, goalRef)} actions={actions} />;
}

/** @public the seam the badge is rendered through in `test/appErrorsCockpit.test.ts` */
export function GoalErrorBadge({
  lines,
  actions,
}: {
  lines: GoalErrorLine[];
  actions: CockpitActions;
}): JSX.Element | null {
  const first = lines[0];
  if (first === undefined) return null;
  const total = lines.reduce((n, l) => n + l.count, 0);
  const where = lines.map((l) => l.environment).join(', ');
  const title = lines
    .map((l) => `${l.count} on ${l.environment}, linked by ${l.how.map((h) => HOW_SAID[h]).join(' and ')}`)
    .join('; ');
  return (
    <Button
      ghost
      size="small"
      tone="danger"
      className="cn-gherrors"
      usage={{ counted: 'app-error.view' }}
      title={`${title}. Open the Errors tab on ${first.environment}.`}
      onClick={() => actions.openErrors({ errorsBand: first.band })}
    >
      {total} new error{total === 1 ? '' : 's'} on {where} since this arrived
    </Button>
  );
}
