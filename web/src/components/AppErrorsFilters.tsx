import { useState, type FormEvent, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { ERRORS_SHOWS, type ErrorsShow, type ErrorsSort } from '../cockpit/place.js';
import { BareButton, Button } from './button.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

const SHOW_LABEL: Record<ErrorsShow, string> = {
  all: 'All',
  ticketless: 'No open ticket',
  goalless: 'No goal linked',
};

export function AppErrorFilters({
  show,
  text,
  actions,
}: {
  show: ErrorsShow;
  text: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const [draft, setDraft] = useState(text ?? '');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = draft.trim();
    actions.openErrors({ errorsText: trimmed === '' ? null : trimmed });
  };
  return (
    <div className="ae-filters">
      <span className="ae-shows" role="group" aria-label="Show">
        {ERRORS_SHOWS.map((value) => (
          <Button
            key={value}
            ghost={value !== show}
            size="small"
            usage="app-error.filter"
            logs={value !== show}
            aria-pressed={value === show}
            onClick={() => actions.openErrors({ errorsShow: value })}
          >
            {SHOW_LABEL[value]}
          </Button>
        ))}
      </span>
      <form className="ae-search" role="search" onSubmit={submit}>
        <input
          type="search"
          className="cn-in"
          value={draft}
          placeholder="Search title, key, operation or frame — Enter"
          aria-label="Search errors"
          onChange={(e) => setDraft(e.target.value)}
        />
        {text !== null && (
          <Button ghost size="small" usage="app-error.filter" onClick={() => actions.openErrors({ errorsText: null })}>
            Clear
          </Button>
        )}
      </form>
    </div>
  );
}

export function SortHead({
  by,
  sort,
  actions,
  className,
  children,
}: {
  by: ErrorsSort;
  sort: ErrorsSort;
  actions: CockpitActions;
  className?: string;
  children: string;
}): JSX.Element {
  const on = by === sort;
  return (
    <th className={className} aria-sort={on ? (by === 'state' ? 'ascending' : 'descending') : undefined}>
      <BareButton
        usage="app-error.filter"
        logs={!on}
        className={on ? 'ae-sort on' : 'ae-sort'}
        onClick={() => actions.openErrors({ errorsSort: by })}
      >
        {children}
      </BareButton>
    </th>
  );
}
