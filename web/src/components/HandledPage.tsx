import type { JSX } from 'react';
import type { HandledAction, HandledKind } from '../types.js';
import { api } from '../api.js';
import { usePolled } from '../hooks.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { relTime } from './util.js';

// → docs/spec/43-handled-for-you.md#the-page

const REFRESH_MS = 30_000;

const GROUPS: readonly { kind: HandledKind; label: string }[] = [
  { kind: 'placement', label: 'Moved to a board' },
  { kind: 'profile', label: 'Goal profile set' },
];

function change(action: HandledAction): string {
  return `${action.before ?? 'none'} → ${action.after}`;
}

function Row({ action, now, reload }: { action: HandledAction; now: number; reload: () => void }): JSX.Element {
  const undone = action.state === 'undone';
  return (
    <li className={`hf-row${undone ? ' hf-undone' : ''}`}>
      <div className="hf-what">
        <span className="cn-refs">
          <Ref to={`issue:${action.issueNumber}`} />
        </span>{' '}
        <span className="hf-change">{change(action)}</span>
        <div className="hf-why">
          {action.reason} · {relTime(action.createdAt, now)}
        </div>
      </div>
      <AsyncButton
        usage="handled.undo"
        size="small"
        tone="secondary"
        onClick={() => api.revertHandled(action.id, undone ? 'redo' : 'undo').then(reload)}
      >
        {undone ? 'Redo' : 'Undo'}
      </AsyncButton>
    </li>
  );
}

function Group({
  label,
  actions,
  now,
  reload,
}: {
  label: string;
  actions: HandledAction[];
  now: number;
  reload: () => void;
}): JSX.Element {
  const open = actions.filter((a) => a.state === 'open');
  return (
    <section className="hf-group">
      <div className="hf-ghead">
        <h3>{label}</h3>
        <i className="cn-count">{actions.length}</i>
        {open.length === 0 ? (
          <span className="hf-checked">checked</span>
        ) : (
          <AsyncButton
            usage="handled.accept"
            size="small"
            ghost
            onClick={() => api.checkHandled(open.map((a) => a.id)).then(reload)}
          >
            Mark checked
          </AsyncButton>
        )}
      </div>
      {open.length > 0 || actions.some((a) => a.state === 'undone') ? (
        <ul className="hf-rows">
          {actions
            .filter((a) => a.state !== 'checked')
            .map((a) => (
              <Row key={a.id} action={a} now={now} reload={reload} />
            ))}
        </ul>
      ) : null}
    </section>
  );
}

export function HandledPage({ now }: { now: number }): JSX.Element {
  const { reading, failed, reload } = usePolled(api.getHandled, REFRESH_MS);
  if (failed && reading === null) return <p className="empty">The handled asks could not be read.</p>;
  if (reading === null) return <p className="empty">Reading handled asks…</p>;

  const all = reading.actions;
  const open = all.filter((a) => a.state === 'open');
  const undone = all.filter((a) => a.state === 'undone').length;
  return (
    <div className="hf">
      <div className="hf-head">
        <h2>Handled for you</h2>
        <p className="hf-blurb">
          Small asks the harness answered itself in the last 24 hours. Undo anything that looks wrong, then mark the
          group checked.
        </p>
      </div>
      <div className="hf-strip">
        <span>
          <b>{open.length}</b> to check
        </span>
        <span>
          <b>{undone}</b> undone
        </span>
        {open.length > 0 && (
          <AsyncButton
            usage="handled.accept"
            tone="primary"
            size="small"
            className="hf-all"
            onClick={() => api.checkHandled(open.map((a) => a.id)).then(reload)}
          >
            Looks good, mark all checked
          </AsyncButton>
        )}
      </div>
      {all.length === 0 ? (
        <p className="empty">Nothing was handled in the last 24 hours.</p>
      ) : (
        GROUPS.map(({ kind, label }) => {
          const actions = all.filter((a) => a.kind === kind);
          return actions.length === 0 ? null : (
            <Group key={kind} label={label} actions={actions} now={now} reload={reload} />
          );
        })
      )}
    </div>
  );
}
